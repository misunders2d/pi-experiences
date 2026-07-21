import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat, truncate } from "node:fs/promises";
import {
	chmodSensitiveFile,
	openSensitiveFileForWrite,
	resolvePrivatePath,
	ensurePrivateRoot,
	normalizeUserId,
	PRIVATE_DIR_MODE,
	SENSITIVE_FILE_MODE,
} from "./private-root.ts";
import { redactJson, redactText } from "./redaction.ts";
import { canonicalJson, checksumJson } from "./checksum.ts";
import { withOwnedLock } from "./locks.ts";

export type ObservationOrigin = { source: "test" | "manual" | "local_interactive"; command?: string };

export interface AppendObservationInput {
	userId?: string;
	origin: ObservationOrigin;
	payload: unknown;
	id?: string;
	createdAt?: string;
}

export interface ObservationRecord {
	id: string;
	seq: number;
	user_id: string;
	origin: ObservationOrigin;
	prev_pair_ref: string | null;
	payload_redacted: unknown;
	created_at: string;
	checksum: string;
}

export interface ObservationTailManifest {
	schema_version: 1;
	file_generation: string;
	last_seq: number;
	last_checksum: string | null;
	last_pair_ref: string | null;
	jsonl_bytes: number;
	index_bytes: number;
	created_at: string;
	updated_at: string;
	manifest_checksum: string;
}

export interface ObservationRangeResult {
	manifest: ObservationTailManifest;
	records: Array<ObservationRecord & { file_generation: string }>;
	has_more: boolean;
	total_unread: number;
	bytes_read: number;
}

const OBSERVATIONS_FILE = "observations.jsonl";
const OBSERVATIONS_INDEX = "observations.idx";
const OBSERVATIONS_TAIL = "observations-tail.json";
const ROTATION_JOURNAL = "observations-rotation.json";
const ARCHIVE_ROOT = "observation-archive";
const LOCK_NAME = "observations";
const MAX_RECORD_BYTES = 64 * 1024;
const DEFAULT_RANGE_RECORDS = 200;
const DEFAULT_RANGE_BYTES = 80_000;
const INDEX_ENTRY_BYTES = 8;
const ALLOWED_RETENTION_DAYS = new Set([7, 14, 30]);

let ioDiagnostics = { full_scans: 0, bounded_bytes_read: 0 };

function normalizeOrigin(origin: ObservationOrigin): ObservationOrigin {
	if (!origin || !["test", "manual", "local_interactive"].includes(origin.source)) throw new Error("Unsupported Agent Experience observation origin");
	return origin.command ? { source: origin.source, command: String(origin.command) } : { source: origin.source };
}

function checksumRecord(record: Omit<ObservationRecord, "checksum">): string {
	return checksumJson(record);
}

function pairRef(record: Pick<ObservationRecord, "seq" | "checksum">): string {
	return `${record.seq}:${record.checksum}`;
}

function assertGeneration(value: unknown): string {
	const generation = String(value || "");
	if (!/^[A-Za-z0-9._-]{1,80}$/.test(generation)) throw new Error("Invalid observation file_generation");
	return generation;
}

function tailChecksum(base: Omit<ObservationTailManifest, "manifest_checksum">): string {
	return checksumJson({ kind: "agent_experience_observation_tail_v1", ...base });
}

function withTailChecksum(base: Omit<ObservationTailManifest, "manifest_checksum">): ObservationTailManifest {
	return { ...base, manifest_checksum: tailChecksum(base) };
}

function parseTailManifest(text: string): ObservationTailManifest {
	let manifest: ObservationTailManifest;
	try { manifest = JSON.parse(text); } catch { throw new Error("Invalid observation tail manifest JSON"); }
	if (!manifest || manifest.schema_version !== 1) throw new Error("Unsupported observation tail manifest");
	assertGeneration(manifest.file_generation);
	if (!Number.isInteger(manifest.last_seq) || manifest.last_seq < 0) throw new Error("Invalid observation tail sequence");
	if (!Number.isInteger(manifest.jsonl_bytes) || manifest.jsonl_bytes < 0 || !Number.isInteger(manifest.index_bytes) || manifest.index_bytes < 0) throw new Error("Invalid observation tail sizes");
	if (manifest.index_bytes !== manifest.last_seq * INDEX_ENTRY_BYTES) throw new Error("Invalid observation index size in manifest");
	if (manifest.last_seq === 0 && (manifest.last_checksum !== null || manifest.last_pair_ref !== null || manifest.jsonl_bytes !== 0)) throw new Error("Invalid empty observation tail manifest");
	if (manifest.last_seq > 0 && (typeof manifest.last_checksum !== "string" || manifest.last_pair_ref !== `${manifest.last_seq}:${manifest.last_checksum}`)) throw new Error("Invalid observation tail pair reference");
	const { manifest_checksum, ...base } = manifest;
	if (manifest_checksum !== tailChecksum(base)) throw new Error("Observation tail manifest checksum mismatch");
	return manifest;
}

async function pathType(path: string): Promise<"file" | "directory" | null> {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink()) throw new Error(`Refusing symlinked Agent Experience path: ${path}`);
		if (info.isFile()) return "file";
		if (info.isDirectory()) return "directory";
		throw new Error(`Unsupported Agent Experience path: ${path}`);
	} catch (error: any) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

async function writeAtomicJson(root: string, path: string, value: unknown): Promise<void> {
	const temp = `${path}.tmp-${randomUUID()}`;
	const handle = await openSensitiveFileForWrite(root, temp);
	try {
		await handle.writeFile(canonicalJson(value), "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temp, path);
	await chmodSensitiveFile(path);
}

async function writeTailManifest(root: string, manifest: ObservationTailManifest): Promise<void> {
	await writeAtomicJson(root, resolvePrivatePath(root, OBSERVATIONS_TAIL), manifest);
}

function validateRecord(value: unknown, input: { expectedSeq: number; expectedPrev: string | null; userId?: string }): ObservationRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid observation record");
	const record = value as ObservationRecord;
	if (!Number.isInteger(record.seq) || record.seq !== input.expectedSeq) throw new Error("Invalid observation seq chain");
	if (input.userId !== undefined && record.user_id !== input.userId) throw new Error("Observation user_id mismatch");
	if (record.prev_pair_ref !== input.expectedPrev) throw new Error("Invalid observation prev_pair_ref chain");
	const { checksum, ...withoutChecksum } = record as any;
	if (typeof checksum !== "string" || checksum !== checksumRecord(withoutChecksum)) throw new Error("Invalid observation checksum");
	return record;
}

async function quarantinePartialTail(root: string, tail: Buffer): Promise<void> {
	if (!tail.length) return;
	const dir = resolvePrivatePath(root, "recovered-tails");
	await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
	const path = resolvePrivatePath(root, "recovered-tails", `${Date.now()}-${randomUUID()}.partial`);
	const handle = await openSensitiveFileForWrite(root, path);
	try {
		await handle.writeFile(redactText(tail.toString("utf8")), "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await chmodSensitiveFile(path);
}

function parseWholeJsonl(bytes: Buffer): { records: ObservationRecord[]; offsets: number[]; completeBytes: number; partial: Buffer } {
	const records: ObservationRecord[] = [];
	const offsets: number[] = [];
	let start = 0;
	let expectedPrev: string | null = null;
	for (let index = 0; index < bytes.length; index += 1) {
		if (bytes[index] !== 0x0a) continue;
		const line = bytes.subarray(start, index);
		if (!line.length) throw new Error("Observation JSONL contains empty line");
		if (line.length > MAX_RECORD_BYTES) throw new Error("Observation record exceeds size limit");
		let parsed: unknown;
		try { parsed = JSON.parse(line.toString("utf8")); } catch { throw new Error("Invalid observation JSONL line"); }
		const record = validateRecord(parsed, { expectedSeq: records.length + 1, expectedPrev });
		records.push(record);
		expectedPrev = pairRef(record);
		offsets.push(index + 1);
		start = index + 1;
	}
	return { records, offsets, completeBytes: start, partial: bytes.subarray(start) };
}

async function writeIndex(root: string, offsets: number[]): Promise<void> {
	const path = resolvePrivatePath(root, OBSERVATIONS_INDEX);
	const buffer = Buffer.alloc(offsets.length * INDEX_ENTRY_BYTES);
	offsets.forEach((offset, index) => buffer.writeBigUInt64BE(BigInt(offset), index * INDEX_ENTRY_BYTES));
	const handle = await openSensitiveFileForWrite(root, path);
	try {
		await handle.writeFile(buffer);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function bootstrapLegacyState(root: string): Promise<ObservationTailManifest> {
	ioDiagnostics.full_scans += 1;
	const jsonPath = resolvePrivatePath(root, OBSERVATIONS_FILE);
	let bytes = Buffer.alloc(0);
	if (await pathType(jsonPath)) bytes = await readFile(jsonPath);
	const parsed = parseWholeJsonl(bytes);
	if (parsed.partial.length) {
		await quarantinePartialTail(root, parsed.partial);
		if (!(await pathType(jsonPath))) {
			const handle = await openSensitiveFileForWrite(root, jsonPath);
			await handle.close();
		} else await truncate(jsonPath, parsed.completeBytes);
	}
	if (!(await pathType(jsonPath))) {
		const handle = await openSensitiveFileForWrite(root, jsonPath);
		await handle.close();
	}
	await chmodSensitiveFile(jsonPath);
	await writeIndex(root, parsed.offsets);
	const now = new Date().toISOString();
	const previous = parsed.records.at(-1);
	const manifest = withTailChecksum({
		schema_version: 1,
		file_generation: "active",
		last_seq: parsed.records.length,
		last_checksum: previous?.checksum || null,
		last_pair_ref: previous ? pairRef(previous) : null,
		jsonl_bytes: parsed.completeBytes,
		index_bytes: parsed.offsets.length * INDEX_ENTRY_BYTES,
		created_at: now,
		updated_at: now,
	});
	await writeTailManifest(root, manifest);
	return manifest;
}

async function readOffset(indexPath: string, seq: number): Promise<number> {
	if (!Number.isInteger(seq) || seq < 1) throw new Error("Invalid observation index sequence");
	const handle = await open(indexPath, constants.O_RDONLY);
	try {
		const buffer = Buffer.alloc(INDEX_ENTRY_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, INDEX_ENTRY_BYTES, (seq - 1) * INDEX_ENTRY_BYTES);
		ioDiagnostics.bounded_bytes_read += bytesRead;
		if (bytesRead !== INDEX_ENTRY_BYTES) throw new Error("Observation index is truncated");
		const value = Number(buffer.readBigUInt64BE());
		if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid observation index offset");
		return value;
	} finally {
		await handle.close();
	}
}

async function readRecordAt(root: string, manifest: ObservationTailManifest, seq: number): Promise<ObservationRecord> {
	const indexPath = resolvePrivatePath(root, OBSERVATIONS_INDEX);
	const jsonPath = resolvePrivatePath(root, OBSERVATIONS_FILE);
	const end = await readOffset(indexPath, seq);
	const start = seq === 1 ? 0 : await readOffset(indexPath, seq - 1);
	const length = end - start;
	if (length < 2 || length > MAX_RECORD_BYTES + 1) throw new Error("Invalid observation indexed record size");
	const handle = await open(jsonPath, constants.O_RDONLY);
	try {
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, start);
		ioDiagnostics.bounded_bytes_read += bytesRead;
		if (bytesRead !== length || buffer.at(-1) !== 0x0a) throw new Error("Observation indexed record is incomplete");
		let parsed: unknown;
		try { parsed = JSON.parse(buffer.subarray(0, -1).toString("utf8")); } catch { throw new Error("Invalid indexed observation JSON"); }
		const expectedPrev = seq === 1 ? null : undefined;
		const record = parsed as ObservationRecord;
		return validateRecord(record, { expectedSeq: seq, expectedPrev: expectedPrev === null ? null : record.prev_pair_ref });
	} finally {
		await handle.close();
	}
}

async function validateManifestTail(root: string, manifest: ObservationTailManifest): Promise<void> {
	const jsonPath = resolvePrivatePath(root, OBSERVATIONS_FILE);
	const indexPath = resolvePrivatePath(root, OBSERVATIONS_INDEX);
	const jsonInfo = await stat(jsonPath);
	const indexInfo = await stat(indexPath);
	if (!jsonInfo.isFile() || !indexInfo.isFile()) throw new Error("Observation state files are not regular files");
	if (jsonInfo.size !== manifest.jsonl_bytes || indexInfo.size !== manifest.index_bytes) throw new Error("Observation tail size mismatch");
	if (manifest.last_seq === 0) return;
	const record = await readRecordAt(root, manifest, manifest.last_seq);
	if (record.checksum !== manifest.last_checksum || pairRef(record) !== manifest.last_pair_ref) throw new Error("Observation tail record mismatch");
	if (manifest.last_seq > 1) {
		const previous = await readRecordAt(root, manifest, manifest.last_seq - 1);
		if (record.prev_pair_ref !== pairRef(previous)) throw new Error("Observation tail chain mismatch");
	}
}

async function recoverAppendCrash(root: string, manifest: ObservationTailManifest): Promise<ObservationTailManifest> {
	const jsonPath = resolvePrivatePath(root, OBSERVATIONS_FILE);
	const indexPath = resolvePrivatePath(root, OBSERVATIONS_INDEX);
	const jsonInfo = await stat(jsonPath);
	const indexInfo = await stat(indexPath);
	if (jsonInfo.size < manifest.jsonl_bytes || indexInfo.size < manifest.index_bytes) throw new Error("Observation state shrank below committed tail");
	if (jsonInfo.size === manifest.jsonl_bytes && indexInfo.size === manifest.index_bytes) {
		await validateManifestTail(root, manifest);
		return manifest;
	}
	if (indexInfo.size > manifest.index_bytes && indexInfo.size < manifest.index_bytes + INDEX_ENTRY_BYTES) await truncate(indexPath, manifest.index_bytes);
	if (jsonInfo.size === manifest.jsonl_bytes) {
		await truncate(indexPath, manifest.index_bytes);
		await validateManifestTail(root, manifest);
		return manifest;
	}
	const extraLength = jsonInfo.size - manifest.jsonl_bytes;
	if (extraLength > MAX_RECORD_BYTES + 1) throw new Error("Observation crash tail exceeds recovery bound");
	const handle = await open(jsonPath, constants.O_RDONLY);
	let extra: Buffer;
	try {
		extra = Buffer.alloc(extraLength);
		const { bytesRead } = await handle.read(extra, 0, extraLength, manifest.jsonl_bytes);
		ioDiagnostics.bounded_bytes_read += bytesRead;
		if (bytesRead !== extraLength) throw new Error("Could not read observation crash tail");
	} finally {
		await handle.close();
	}
	if (extra.at(-1) !== 0x0a || extra.subarray(0, -1).includes(0x0a)) {
		await quarantinePartialTail(root, extra);
		await truncate(jsonPath, manifest.jsonl_bytes);
		await truncate(indexPath, manifest.index_bytes);
		return manifest;
	}
	let parsed: unknown;
	try { parsed = JSON.parse(extra.subarray(0, -1).toString("utf8")); } catch {
		await quarantinePartialTail(root, extra);
		await truncate(jsonPath, manifest.jsonl_bytes);
		await truncate(indexPath, manifest.index_bytes);
		return manifest;
	}
	const record = validateRecord(parsed, { expectedSeq: manifest.last_seq + 1, expectedPrev: manifest.last_pair_ref });
	const expectedIndexSize = manifest.index_bytes + INDEX_ENTRY_BYTES;
	if ((await stat(indexPath)).size === expectedIndexSize) {
		const offset = await readOffset(indexPath, record.seq);
		if (offset !== jsonInfo.size) throw new Error("Observation crash index offset mismatch");
	} else {
		await truncate(indexPath, manifest.index_bytes);
		const indexHandle = await openSensitiveFileForWrite(root, indexPath, constants.O_APPEND | constants.O_WRONLY);
		try {
			const entry = Buffer.alloc(INDEX_ENTRY_BYTES);
			entry.writeBigUInt64BE(BigInt(jsonInfo.size));
			await indexHandle.writeFile(entry);
			await indexHandle.sync();
		} finally { await indexHandle.close(); }
	}
	const { manifest_checksum: _manifestChecksum, ...manifestBase } = manifest;
	const recovered = withTailChecksum({
		...manifestBase,
		last_seq: record.seq,
		last_checksum: record.checksum,
		last_pair_ref: pairRef(record),
		jsonl_bytes: jsonInfo.size,
		index_bytes: expectedIndexSize,
		updated_at: new Date().toISOString(),
	});
	await writeTailManifest(root, recovered);
	await validateManifestTail(root, recovered);
	return recovered;
}

async function loadStateLocked(root: string): Promise<ObservationTailManifest> {
	await recoverInterruptedRotationLocked(root);
	const tailPath = resolvePrivatePath(root, OBSERVATIONS_TAIL);
	const jsonPath = resolvePrivatePath(root, OBSERVATIONS_FILE);
	const indexPath = resolvePrivatePath(root, OBSERVATIONS_INDEX);
	const tailType = await pathType(tailPath);
	const jsonType = await pathType(jsonPath);
	const indexType = await pathType(indexPath);
	if (!tailType) return bootstrapLegacyState(root);
	if (tailType !== "file" || jsonType !== "file" || indexType !== "file") throw new Error("Observation state is incomplete");
	const manifest = parseTailManifest(await readFile(tailPath, "utf8"));
	return recoverAppendCrash(root, manifest);
}

export async function readCurrentObservationManifest(root: string): Promise<ObservationTailManifest> {
	const privateRoot = await ensurePrivateRoot(root);
	return withOwnedLock(privateRoot, LOCK_NAME, () => loadStateLocked(privateRoot), { waitMs: 10_000 });
}

export async function initializeFreshObservationGeneration(root: string, createdAt = new Date().toISOString()) {
	const privateRoot = await ensurePrivateRoot(root);
	return withOwnedLock(privateRoot, LOCK_NAME, async () => {
		await recoverInterruptedRotationLocked(privateRoot);
		const generation = `g-restore-${createdAt.replace(/[^0-9]/g, "").slice(0, 17)}-${randomUUID().slice(0, 8)}`;
		await createEmptyGeneration(privateRoot, generation, createdAt);
		return parseTailManifest(await readFile(resolvePrivatePath(privateRoot, OBSERVATIONS_TAIL), "utf8"));
	}, { waitMs: 10_000 });
}

export async function appendObservation(root: string, input: AppendObservationInput) {
	const privateRoot = await ensurePrivateRoot(root);
	const userId = normalizeUserId(input.userId);
	const origin = normalizeOrigin(input.origin);
	const payloadRedacted = redactJson(input.payload);
	return withOwnedLock(privateRoot, LOCK_NAME, async () => {
		const manifest = await loadStateLocked(privateRoot);
		const recordBase: Omit<ObservationRecord, "checksum"> = {
			id: input.id || randomUUID(),
			seq: manifest.last_seq + 1,
			user_id: userId,
			origin,
			prev_pair_ref: manifest.last_pair_ref,
			payload_redacted: payloadRedacted,
			created_at: input.createdAt || new Date().toISOString(),
		};
		const record: ObservationRecord = { ...recordBase, checksum: checksumRecord(recordBase) };
		const line = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
		if (line.length > MAX_RECORD_BYTES + 1) throw new Error("Observation record exceeds size limit");
		const jsonPath = resolvePrivatePath(privateRoot, OBSERVATIONS_FILE);
		const jsonHandle = await openSensitiveFileForWrite(privateRoot, jsonPath, constants.O_APPEND | constants.O_WRONLY);
		try { await jsonHandle.writeFile(line); await jsonHandle.sync(); } finally { await jsonHandle.close(); }
		const nextJsonBytes = manifest.jsonl_bytes + line.length;
		const indexPath = resolvePrivatePath(privateRoot, OBSERVATIONS_INDEX);
		const indexHandle = await openSensitiveFileForWrite(privateRoot, indexPath, constants.O_APPEND | constants.O_WRONLY);
		try {
			const entry = Buffer.alloc(INDEX_ENTRY_BYTES);
			entry.writeBigUInt64BE(BigInt(nextJsonBytes));
			await indexHandle.writeFile(entry);
			await indexHandle.sync();
		} finally { await indexHandle.close(); }
		const { manifest_checksum: _manifestChecksum, ...manifestBase } = manifest;
		const next = withTailChecksum({
			...manifestBase,
			last_seq: record.seq,
			last_checksum: record.checksum,
			last_pair_ref: pairRef(record),
			jsonl_bytes: nextJsonBytes,
			index_bytes: manifest.index_bytes + INDEX_ENTRY_BYTES,
			updated_at: record.created_at,
		});
		await writeTailManifest(privateRoot, next);
		return { record, path: jsonPath, manifest: next };
	}, { waitMs: 10_000 });
}

export async function readValidatedObservationRange(root: string, input: { userId?: string; afterSeq?: number; afterChecksum?: string | null; maxRecords?: number; maxBytes?: number; expectedGeneration?: string; throughSeq?: number }): Promise<ObservationRangeResult> {
	const privateRoot = await ensurePrivateRoot(root);
	const userId = normalizeUserId(input.userId);
	const afterSeq = Math.max(0, Math.trunc(input.afterSeq || 0));
	const maxRecords = Math.max(1, Math.min(500, Math.trunc(input.maxRecords || DEFAULT_RANGE_RECORDS)));
	const maxBytes = Math.max(MAX_RECORD_BYTES + 1, Math.min(2_000_000, Math.trunc(input.maxBytes || DEFAULT_RANGE_BYTES)));
	return withOwnedLock(privateRoot, LOCK_NAME, async () => {
		const manifest = await loadStateLocked(privateRoot);
		if (input.expectedGeneration && manifest.file_generation !== input.expectedGeneration) throw new Error("Observation generation changed during bounded read");
		const throughSeq = input.throughSeq === undefined ? manifest.last_seq : Math.trunc(input.throughSeq);
		if (!Number.isInteger(throughSeq) || throughSeq < afterSeq || throughSeq > manifest.last_seq) throw new Error("Observation read boundary is invalid");
		if (afterSeq > manifest.last_seq) throw new Error("Observation read watermark is beyond current generation");
		if (afterSeq > 0) {
			const previous = await readRecordAt(privateRoot, manifest, afterSeq);
			if (previous.user_id !== userId || previous.checksum !== input.afterChecksum) throw new Error("Observation read watermark checksum mismatch");
		} else if (input.afterChecksum) throw new Error("Observation read watermark checksum without sequence");
		if (afterSeq === throughSeq) return { manifest, records: [], has_more: false, total_unread: 0, bytes_read: 0 };
		const startOffset = afterSeq === 0 ? 0 : await readOffset(resolvePrivatePath(privateRoot, OBSERVATIONS_INDEX), afterSeq);
		const desiredCount = Math.min(maxRecords, throughSeq - afterSeq);
		const indexHandle = await open(resolvePrivatePath(privateRoot, OBSERVATIONS_INDEX), constants.O_RDONLY);
		const offsetsBuffer = Buffer.alloc(desiredCount * INDEX_ENTRY_BYTES);
		try {
			const { bytesRead } = await indexHandle.read(offsetsBuffer, 0, offsetsBuffer.length, afterSeq * INDEX_ENTRY_BYTES);
			ioDiagnostics.bounded_bytes_read += bytesRead;
			if (bytesRead !== offsetsBuffer.length) throw new Error("Observation range index is truncated");
		} finally { await indexHandle.close(); }
		let count = 0;
		let endOffset = startOffset;
		for (let index = 0; index < desiredCount; index += 1) {
			const candidate = Number(offsetsBuffer.readBigUInt64BE(index * INDEX_ENTRY_BYTES));
			if (!Number.isSafeInteger(candidate) || candidate <= endOffset) throw new Error("Invalid observation range index offset");
			if (candidate - startOffset > maxBytes && count > 0) break;
			if (candidate - startOffset > maxBytes) throw new Error("Single observation exceeds Analyze byte bound");
			endOffset = candidate;
			count += 1;
		}
		const length = endOffset - startOffset;
		const jsonHandle = await open(resolvePrivatePath(privateRoot, OBSERVATIONS_FILE), constants.O_RDONLY);
		const bytes = Buffer.alloc(length);
		try {
			const { bytesRead } = await jsonHandle.read(bytes, 0, length, startOffset);
			ioDiagnostics.bounded_bytes_read += bytesRead;
			if (bytesRead !== length) throw new Error("Observation range JSONL is truncated");
		} finally { await jsonHandle.close(); }
		const records: Array<ObservationRecord & { file_generation: string }> = [];
		let previousRef = afterSeq === 0 ? null : `${afterSeq}:${input.afterChecksum}`;
		for (const line of bytes.toString("utf8").split("\n")) {
			if (!line) continue;
			let parsed: unknown;
			try { parsed = JSON.parse(line); } catch { throw new Error("Invalid observation range JSON"); }
			const record = validateRecord(parsed, { expectedSeq: afterSeq + records.length + 1, expectedPrev: previousRef, userId });
			records.push({ ...record, file_generation: manifest.file_generation });
			previousRef = pairRef(record);
		}
		if (records.length !== count) throw new Error("Observation range record count mismatch");
		return { manifest, records, has_more: afterSeq + count < throughSeq, total_unread: throughSeq - afterSeq, bytes_read: length };
	}, { waitMs: 10_000 });
}

interface RotationJournalBase {
	schema_version: 1;
	phase: "prepared" | "moved" | "committed";
	old_generation: string;
	new_generation: string;
	rotated_at: string;
	retention_days: number;
}

interface RotationJournal extends RotationJournalBase { checksum: string }

function rotationChecksum(base: RotationJournalBase): string {
	return checksumJson({ kind: "agent_experience_observation_rotation_v1", ...base });
}

function withRotationChecksum(base: RotationJournalBase): RotationJournal {
	return { ...base, checksum: rotationChecksum(base) };
}

async function writeRotationJournal(root: string, journal: RotationJournal): Promise<void> {
	await writeAtomicJson(root, resolvePrivatePath(root, ROTATION_JOURNAL), journal);
}

async function readRotationJournal(root: string): Promise<RotationJournal | null> {
	const path = resolvePrivatePath(root, ROTATION_JOURNAL);
	if (!(await pathType(path))) return null;
	const journal = JSON.parse(await readFile(path, "utf8")) as RotationJournal;
	const { checksum, ...base } = journal;
	if (checksum !== rotationChecksum(base) || journal.schema_version !== 1 || !["prepared", "moved", "committed"].includes(journal.phase)) throw new Error("Invalid observation rotation journal");
	assertGeneration(journal.old_generation);
	assertGeneration(journal.new_generation);
	if (!ALLOWED_RETENTION_DAYS.has(journal.retention_days)) throw new Error("Invalid observation retention in rotation journal");
	return journal;
}

function archiveMeta(journal: RotationJournal) {
	const base = { schema_version: 1, file_generation: journal.old_generation, rotated_at: journal.rotated_at, expires_at: new Date(Date.parse(journal.rotated_at) + journal.retention_days * 86_400_000).toISOString(), retention_days: journal.retention_days };
	return { ...base, checksum: checksumJson({ kind: "agent_experience_observation_archive_v1", ...base }) };
}

async function createEmptyGeneration(root: string, generation: string, createdAt: string): Promise<void> {
	for (const name of [OBSERVATIONS_FILE, OBSERVATIONS_INDEX]) {
		const path = resolvePrivatePath(root, name);
		await rm(path, { force: true });
		const handle = await openSensitiveFileForWrite(root, path);
		await handle.close();
	}
	await writeTailManifest(root, withTailChecksum({ schema_version: 1, file_generation: generation, last_seq: 0, last_checksum: null, last_pair_ref: null, jsonl_bytes: 0, index_bytes: 0, created_at: createdAt, updated_at: createdAt }));
}

async function recoverInterruptedRotationLocked(root: string): Promise<void> {
	const journal = await readRotationJournal(root);
	if (!journal) return;
	const archiveDir = resolvePrivatePath(root, ARCHIVE_ROOT, journal.old_generation);
	if (journal.phase === "prepared") {
		for (const name of [OBSERVATIONS_FILE, OBSERVATIONS_INDEX, OBSERVATIONS_TAIL]) {
			const archived = resolvePrivatePath(root, ARCHIVE_ROOT, journal.old_generation, name);
			if (await pathType(archived)) {
				await rm(resolvePrivatePath(root, name), { force: true });
				await rename(archived, resolvePrivatePath(root, name));
			}
		}
		await rm(archiveDir, { recursive: true, force: true });
		await rm(resolvePrivatePath(root, ROTATION_JOURNAL), { force: true });
		return;
	}
	for (const name of [OBSERVATIONS_FILE, OBSERVATIONS_INDEX, OBSERVATIONS_TAIL]) if (!(await pathType(resolvePrivatePath(root, ARCHIVE_ROOT, journal.old_generation, name)))) throw new Error("Interrupted observation rotation is missing archived state");
	await createEmptyGeneration(root, journal.new_generation, journal.rotated_at);
	await writeAtomicJson(root, resolvePrivatePath(root, ARCHIVE_ROOT, journal.old_generation, "archive.json"), archiveMeta(journal));
	await rm(resolvePrivatePath(root, ROTATION_JOURNAL), { force: true });
}

export async function rotateObservationGenerationIfFullyRead(root: string, input: { userId?: string; fileGeneration: string; seq: number; checksum: string; retentionDays?: number; now?: string; _testFailurePhase?: "prepared" | "moved" | "committed" }) {
	const privateRoot = await ensurePrivateRoot(root);
	const userId = normalizeUserId(input.userId);
	const retentionDays = Math.trunc(input.retentionDays ?? 7);
	if (!ALLOWED_RETENTION_DAYS.has(retentionDays)) throw new Error("Observation retention must be 7, 14, or 30 days");
	return withOwnedLock(privateRoot, LOCK_NAME, async () => {
		const manifest = await loadStateLocked(privateRoot);
		if (manifest.file_generation !== input.fileGeneration || manifest.last_seq !== input.seq || manifest.last_checksum !== input.checksum) return { rotated: false, reason: "new_observations_or_generation_changed", manifest };
		if (manifest.last_seq < 1) return { rotated: false, reason: "empty", manifest };
		const last = await readRecordAt(privateRoot, manifest, manifest.last_seq);
		if (last.user_id !== userId) throw new Error("Observation rotation user mismatch");
		const rotatedAt = input.now || new Date().toISOString();
		const newGeneration = `g-${rotatedAt.replace(/[^0-9]/g, "").slice(0, 17)}-${randomUUID().slice(0, 12)}`;
		const archiveRoot = resolvePrivatePath(privateRoot, ARCHIVE_ROOT);
		await mkdir(archiveRoot, { recursive: true, mode: PRIVATE_DIR_MODE });
		const archiveDir = resolvePrivatePath(privateRoot, ARCHIVE_ROOT, manifest.file_generation);
		if (await pathType(archiveDir)) throw new Error("Observation archive generation already exists");
		await mkdir(archiveDir, { mode: PRIVATE_DIR_MODE });
		let journal = withRotationChecksum({ schema_version: 1, phase: "prepared", old_generation: manifest.file_generation, new_generation: newGeneration, rotated_at: rotatedAt, retention_days: retentionDays });
		await writeRotationJournal(privateRoot, journal);
		if (input._testFailurePhase === "prepared") throw new Error("Injected observation rotation failure after prepared");
		for (const name of [OBSERVATIONS_FILE, OBSERVATIONS_INDEX, OBSERVATIONS_TAIL]) await rename(resolvePrivatePath(privateRoot, name), resolvePrivatePath(privateRoot, ARCHIVE_ROOT, manifest.file_generation, name));
		{
			const { checksum: _checksum, ...base } = journal;
			journal = withRotationChecksum({ ...base, phase: "moved" });
		}
		await writeRotationJournal(privateRoot, journal);
		if (input._testFailurePhase === "moved") throw new Error("Injected observation rotation failure after moved");
		await createEmptyGeneration(privateRoot, newGeneration, rotatedAt);
		await writeAtomicJson(privateRoot, resolvePrivatePath(privateRoot, ARCHIVE_ROOT, manifest.file_generation, "archive.json"), archiveMeta(journal));
		{
			const { checksum: _checksum, ...base } = journal;
			journal = withRotationChecksum({ ...base, phase: "committed" });
		}
		await writeRotationJournal(privateRoot, journal);
		if (input._testFailurePhase === "committed") throw new Error("Injected observation rotation failure after committed");
		await rm(resolvePrivatePath(privateRoot, ROTATION_JOURNAL), { force: true });
		return { rotated: true, old_generation: manifest.file_generation, new_generation: newGeneration };
	}, { waitMs: 10_000 });
}

export async function purgeExpiredObservationArchives(root: string, input: { now?: string } = {}) {
	const privateRoot = await ensurePrivateRoot(root);
	const now = Date.parse(input.now || new Date().toISOString());
	if (!Number.isFinite(now)) throw new Error("Invalid observation retention time");
	return withOwnedLock(privateRoot, LOCK_NAME, async () => {
		await recoverInterruptedRotationLocked(privateRoot);
		const archiveRoot = resolvePrivatePath(privateRoot, ARCHIVE_ROOT);
		const entries = await readdir(archiveRoot).catch((error: any) => error?.code === "ENOENT" ? [] : Promise.reject(error));
		const deleted: string[] = [];
		for (const entry of entries.sort()) {
			assertGeneration(entry);
			const dir = resolvePrivatePath(privateRoot, ARCHIVE_ROOT, entry);
			if (await pathType(dir) !== "directory") throw new Error("Observation archive entry is not a private directory");
			const metaPath = resolvePrivatePath(privateRoot, ARCHIVE_ROOT, entry, "archive.json");
			if (await pathType(metaPath) !== "file") throw new Error("Observation archive metadata missing");
			const meta = JSON.parse(await readFile(metaPath, "utf8"));
			const { checksum, ...base } = meta;
			if (checksum !== checksumJson({ kind: "agent_experience_observation_archive_v1", ...base }) || meta.file_generation !== entry) throw new Error("Observation archive metadata checksum mismatch");
			if (Date.parse(meta.expires_at) <= now) {
				await rm(dir, { recursive: true, force: true });
				deleted.push(entry);
			}
		}
		return { deleted };
	}, { waitMs: 10_000 });
}

export function __resetObservationIoDiagnosticsForTest(): void {
	ioDiagnostics = { full_scans: 0, bounded_bytes_read: 0 };
}

export function __getObservationIoDiagnosticsForTest() {
	return { ...ioDiagnostics };
}

export const observationChecksumForTest = checksumRecord;
export const observationPairRefForTest = pairRef;
export const OBSERVATION_FILE_MODE = SENSITIVE_FILE_MODE;
export const OBSERVATION_RETENTION_CHOICES = [7, 14, 30] as const;
