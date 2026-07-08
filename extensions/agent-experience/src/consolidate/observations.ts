import { readFile } from "node:fs/promises";
import { resolvePrivatePath, ensurePrivateRoot, normalizeUserId } from "../storage/private-root.ts";
import { checksumJson } from "../storage/checksum.ts";
import type { ObservationRecord } from "../storage/observations.ts";

export interface ObservationGenerationManifest {
	file_generation: string;
	path?: string;
}

export interface ValidatedObservationRecord extends ObservationRecord {
	file_generation: string;
}

const ALLOWED_ORIGINS = new Set(["test", "manual", "local_interactive"]);
const SUPPORTED_PAYLOAD_KINDS = new Set(["conversation_pair_v1"]);
const OBSERVATION_KEYS = new Set(["id", "seq", "user_id", "origin", "prev_pair_ref", "payload_redacted", "created_at", "checksum"]);

export function defaultObservationManifest(): ObservationGenerationManifest {
	return { file_generation: "active", path: "observations.jsonl" };
}

function assertSafeGeneration(generation: unknown): string {
	if (typeof generation !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(generation)) {
		throw new Error("Invalid observation file_generation");
	}
	return generation;
}

function pairRef(record: Pick<ObservationRecord, "seq" | "checksum">): string {
	return `${record.seq}:${record.checksum}`;
}

function checksumRecord(record: Omit<ObservationRecord, "checksum">): string {
	return checksumJson(record);
}

function assertExactObservationKeys(record: Record<string, unknown>): void {
	for (const key of Object.keys(record)) {
		if (!OBSERVATION_KEYS.has(key)) throw new Error(`Observation record has unsupported field: ${key}`);
	}
}

function validatePayloadKind(record: ObservationRecord): void {
	const kind = (record.payload_redacted as any)?.kind;
	if (typeof kind !== "string" || !SUPPORTED_PAYLOAD_KINDS.has(kind)) throw new Error("Unsupported observation payload kind");
}

export function validateObservationRecords(input: {
	records: unknown[];
	userId: string;
	fileGeneration: string;
}): ValidatedObservationRecord[] {
	const userId = normalizeUserId(input.userId);
	const fileGeneration = assertSafeGeneration(input.fileGeneration);
	let expectedSeq = 1;
	let previous: ObservationRecord | undefined;
	const out: ValidatedObservationRecord[] = [];
	for (const value of input.records) {
		const record = value as ObservationRecord;
		if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Invalid observation record");
		assertExactObservationKeys(record as unknown as Record<string, unknown>);
		if (!Number.isInteger(record.seq) || record.seq !== expectedSeq) throw new Error("Invalid observation seq chain");
		if (record.user_id !== userId) throw new Error("Observation user_id mismatch");
		if (!record.origin || !ALLOWED_ORIGINS.has((record.origin as any).source)) throw new Error("Unsupported observation origin");
		validatePayloadKind(record);
		const expectedPrev = previous ? pairRef(previous) : null;
		if (record.prev_pair_ref !== expectedPrev) throw new Error("Invalid observation prev_pair_ref chain");
		const { checksum, ...withoutChecksum } = record as any;
		if (typeof checksum !== "string" || checksum !== checksumRecord(withoutChecksum)) throw new Error("Invalid observation checksum");
		out.push({ ...record, file_generation: fileGeneration });
		previous = record;
		expectedSeq++;
	}
	return out;
}

export async function readValidatedObservationGeneration(root: string, manifest: ObservationGenerationManifest, userId: string): Promise<ValidatedObservationRecord[]> {
	const privateRoot = await ensurePrivateRoot(root);
	const fileGeneration = assertSafeGeneration(manifest.file_generation);
	const fileName = manifest.path || "observations.jsonl";
	const path = resolvePrivatePath(privateRoot, fileName);
	const text = await readFile(path, "utf8");
	if (!text.endsWith("\n")) throw new Error("Observation JSONL has incomplete tail");
	const records = text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
	return validateObservationRecords({ records, userId, fileGeneration });
}

export function observationKey(ref: { file_generation: string; seq: number }): string {
	return `${ref.file_generation}:${ref.seq}`;
}

export const observationPairRefForConsolidation = pairRef;
