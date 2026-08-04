import { lstat, readFile } from "node:fs/promises";
import { resolvePrivatePath, ensurePrivateRoot, normalizeUserId } from "../storage/private-root.ts";
import { checksumJson } from "../storage/checksum.ts";
import { readCurrentObservationManifest, type ObservationRecord } from "../storage/observations.ts";
import { containsUnredactedSensitiveText } from "../storage/redaction.ts";

export interface ObservationGenerationManifest {
	file_generation: string;
	path?: string;
}

export interface ValidatedObservationRecord extends ObservationRecord {
	file_generation: string;
}

const ALLOWED_ORIGINS = new Set(["test", "manual", "local_interactive", "advisor_finding"]);
const SUPPORTED_PAYLOAD_KINDS = new Set(["conversation_pair_v1", "advisor_finding_v1"]);
const OBSERVATION_KEYS = new Set(["id", "seq", "user_id", "origin", "prev_pair_ref", "payload_redacted", "created_at", "checksum"]);
const ORIGIN_KEYS = new Set(["source", "command"]);
const ADVISOR_PAYLOAD_KEYS = new Set([
	"kind",
	"finding_kind",
	"severity",
	"current_request_redacted",
	"primary_behavior_redacted",
	"advice_redacted",
	"event_fingerprint",
	"primary_created_at",
]);

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

function validateOriginAndPayload(record: ObservationRecord): void {
	const origin = record.origin as unknown as Record<string, unknown>;
	if (!origin || typeof origin !== "object" || Array.isArray(origin)) throw new Error("Unsupported observation origin");
	for (const key of Object.keys(origin)) {
		if (!ORIGIN_KEYS.has(key)) throw new Error("Unsupported observation origin field");
	}
	if (typeof origin.source !== "string" || !ALLOWED_ORIGINS.has(origin.source)) throw new Error("Unsupported observation origin");
	if (origin.command !== undefined && typeof origin.command !== "string") throw new Error("Invalid observation origin command");
	if (origin.source === "advisor_finding" && Object.keys(origin).length !== 1) throw new Error("Advisor finding observation origin must be exact");

	const payload = record.payload_redacted as Record<string, unknown>;
	const kind = payload?.kind;
	if (typeof kind !== "string" || !SUPPORTED_PAYLOAD_KINDS.has(kind)) throw new Error("Unsupported observation payload kind");
	if ((origin.source === "advisor_finding") !== (kind === "advisor_finding_v1")) throw new Error("Observation origin and payload kind mismatch");
	if (kind !== "advisor_finding_v1") return;
	for (const key of Object.keys(payload)) {
		if (!ADVISOR_PAYLOAD_KEYS.has(key)) throw new Error("Unsupported Advisor finding payload field");
	}
	if (Object.keys(payload).length !== ADVISOR_PAYLOAD_KEYS.size) throw new Error("Incomplete Advisor finding payload");
	if (payload.finding_kind !== "generic_advice" && payload.finding_kind !== "habit_violation") throw new Error("Invalid Advisor finding kind");
	if (payload.severity !== "nit" && payload.severity !== "concern" && payload.severity !== "blocker") throw new Error("Invalid Advisor finding severity");
	if (typeof payload.current_request_redacted !== "string" || payload.current_request_redacted.length > 1_000) throw new Error("Invalid Advisor current request");
	if (typeof payload.primary_behavior_redacted !== "string" || payload.primary_behavior_redacted.length > 3_000) throw new Error("Invalid Advisor primary behavior");
	if (typeof payload.advice_redacted !== "string" || payload.advice_redacted.length > 1_200) throw new Error("Invalid Advisor advice");
	if (typeof payload.event_fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(payload.event_fingerprint)) throw new Error("Invalid Advisor event fingerprint");
	if (typeof payload.primary_created_at !== "string" || !Number.isFinite(Date.parse(payload.primary_created_at)) || new Date(payload.primary_created_at).toISOString() !== payload.primary_created_at) throw new Error("Invalid Advisor primary timestamp");
	if (JSON.stringify(payload).length > 6_000) throw new Error("Advisor finding payload exceeds size limit");
	if (containsUnredactedSensitiveText(payload)) throw new Error("Advisor finding payload contains sensitive text");
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
		validateOriginAndPayload(record);
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
	const fileName = manifest.path || "observations.jsonl";
	const current = fileName === "observations.jsonl" && manifest.file_generation === "active" ? await readCurrentObservationManifest(privateRoot) : null;
	const fileGeneration = assertSafeGeneration(current?.file_generation || manifest.file_generation);
	const path = resolvePrivatePath(privateRoot, fileName);
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink()) throw new Error("Observation JSONL is not a regular private file");
	const text = await readFile(path, "utf8");
	if (!text.endsWith("\n")) throw new Error("Observation JSONL has incomplete tail");
	const records = text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
	return validateObservationRecords({ records, userId, fileGeneration });
}

export function observationKey(ref: { file_generation: string; seq: number }): string {
	return `${ref.file_generation}:${ref.seq}`;
}

export const observationPairRefForConsolidation = pairRef;
