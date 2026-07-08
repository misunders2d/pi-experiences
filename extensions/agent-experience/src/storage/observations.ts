import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
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

const OBSERVATIONS_FILE = "observations.jsonl";
const LOCK_FILE = ".observations.lock";
const LOCK_TIMEOUT_MS = 2000;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 1500;

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeOrigin(origin: ObservationOrigin): ObservationOrigin {
	if (!origin || !["test", "manual", "local_interactive"].includes(origin.source)) {
		throw new Error("Unsupported Agent Experience observation origin");
	}
	return origin.command ? { source: origin.source, command: String(origin.command) } : { source: origin.source };
}

function checksumRecord(record: Omit<ObservationRecord, "checksum">): string {
	return checksumJson(record);
}

function pairRef(record: ObservationRecord): string {
	return `${record.seq}:${record.checksum}`;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error: any) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

function isProcessAlive(pid: unknown): boolean {
	if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
	try {
		process.kill(Number(pid), 0);
		return true;
	} catch {
		return false;
	}
}

async function tryRecoverStaleLock(lockPath: string): Promise<void> {
	let stats;
	try {
		stats = await stat(lockPath);
	} catch (error: any) {
		if (error?.code === "ENOENT") return;
		throw error;
	}
	if (Date.now() - stats.mtimeMs <= LOCK_STALE_MS) return;
	let pid: unknown;
	try {
		const raw = await readFile(lockPath, "utf8");
		pid = JSON.parse(raw || "{}").pid;
	} catch {
		pid = undefined;
	}
	if (isProcessAlive(pid)) return;
	await rm(lockPath, { force: true });
}

async function withObservationLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
	const lockPath = resolvePrivatePath(root, LOCK_FILE);
	const started = Date.now();
	let handle: Awaited<ReturnType<typeof openSensitiveFileForWrite>> | undefined;
	while (!handle) {
		try {
			handle = await openSensitiveFileForWrite(root, lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
			await handle.writeFile(canonicalJson({ pid: process.pid, created_at: new Date().toISOString() }), "utf8");
			await handle.sync();
		} catch (error: any) {
			if (error?.code !== "EEXIST") throw new Error("Could not acquire Agent Experience observation lock");
			await tryRecoverStaleLock(lockPath);
			if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error("Could not acquire Agent Experience observation lock");
			await sleep(LOCK_RETRY_MS);
		}
	}
	try {
		return await fn();
	} finally {
		await handle.close();
		await rm(lockPath, { force: true });
	}
}

function parseAndValidateLines(text: string): ObservationRecord[] {
	const records: ObservationRecord[] = [];
	let expectedSeq = 1;
	let previous: ObservationRecord | undefined;
	for (const line of text.split("\n")) {
		if (!line) continue;
		let record: ObservationRecord;
		try {
			record = JSON.parse(line);
		} catch {
			throw new Error("Invalid observation JSONL line");
		}
		if (!Number.isInteger(record.seq) || record.seq !== expectedSeq) throw new Error("Invalid observation seq chain");
		const expectedPrev = previous ? pairRef(previous) : null;
		if (record.prev_pair_ref !== expectedPrev) throw new Error("Invalid observation prev_pair_ref chain");
		const { checksum, ...withoutChecksum } = record as any;
		if (typeof checksum !== "string" || checksum !== checksumRecord(withoutChecksum)) throw new Error("Invalid observation checksum");
		records.push(record);
		previous = record;
		expectedSeq++;
	}
	return records;
}

async function quarantinePartialTail(root: string, tail: string): Promise<void> {
	const dir = resolvePrivatePath(root, "recovered-tails");
	await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
	const path = resolvePrivatePath(root, "recovered-tails", `${Date.now()}-${randomUUID()}.partial`);
	const handle = await openSensitiveFileForWrite(root, path);
	try {
		await handle.writeFile(redactText(tail), "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await chmodSensitiveFile(path);
}

async function readValidatedObservationRecords(root: string, observationsPath: string, recoverFinalPartial: boolean): Promise<ObservationRecord[]> {
	if (!(await pathExists(observationsPath))) return [];
	const text = await readFile(observationsPath, "utf8");
	if (!text) return [];
	if (!text.endsWith("\n")) {
		const lastBreak = text.lastIndexOf("\n");
		const prefix = lastBreak >= 0 ? text.slice(0, lastBreak + 1) : "";
		const tail = lastBreak >= 0 ? text.slice(lastBreak + 1) : text;
		const records = parseAndValidateLines(prefix);
		if (!recoverFinalPartial || !tail) throw new Error("Observation JSONL has incomplete tail");
		await quarantinePartialTail(root, tail);
		const handle = await openSensitiveFileForWrite(root, observationsPath);
		try {
			await handle.writeFile(prefix, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		return records;
	}
	return parseAndValidateLines(text);
}

export async function appendObservation(root: string, input: AppendObservationInput) {
	const privateRoot = await ensurePrivateRoot(root);
	const userId = normalizeUserId(input.userId);
	const origin = normalizeOrigin(input.origin);
	const payloadRedacted = redactJson(input.payload);
	const observationsPath = resolvePrivatePath(privateRoot, OBSERVATIONS_FILE);
	return await withObservationLock(privateRoot, async () => {
		const records = await readValidatedObservationRecords(privateRoot, observationsPath, true);
		const previous = records.at(-1);
		const recordBase: Omit<ObservationRecord, "checksum"> = {
			id: input.id || randomUUID(),
			seq: records.length + 1,
			user_id: userId,
			origin,
			prev_pair_ref: previous ? pairRef(previous) : null,
			payload_redacted: payloadRedacted,
			created_at: input.createdAt || new Date().toISOString(),
		};
		const record: ObservationRecord = { ...recordBase, checksum: checksumRecord(recordBase) };
		const handle = await openSensitiveFileForWrite(privateRoot, observationsPath, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY);
		try {
			await handle.writeFile(`${canonicalJson(record)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await chmodSensitiveFile(observationsPath);
		return { record, path: observationsPath };
	});
}

export const observationChecksumForTest = checksumRecord;
export const observationPairRefForTest = pairRef;
export const OBSERVATION_FILE_MODE = SENSITIVE_FILE_MODE;
