import { normalizeUserId } from "../storage/private-root.ts";
import { canonicalJson, checksumJson, sha256Hex } from "../storage/checksum.ts";
import { containsUnredactedSensitiveText, redactJson } from "../storage/redaction.ts";
import type { ValidatedObservationRecord } from "./observations.ts";
import { observationKey } from "./observations.ts";
import { consolidateProposalBatch, recordProposalReadCoverageInTransaction, recordZeroProposalReadCoverage, type ConsolidationResult } from "./commit.ts";
import type { ProposalBatch, ProposalSourceRef } from "./proposals.ts";

export type ModelProposalKind = "habit_candidate" | "correction_split";

export interface ModelOutputSourceRef extends ProposalSourceRef {}

export interface HabitCandidateModelProposal {
	proposal_id: string;
	kind: "habit_candidate";
	candidate_key: string;
	condition: string;
	behavior: string;
	polarity: 1 | -1;
	confidence_bp: number;
	source_refs: ModelOutputSourceRef[];
	evidence_summary?: string;
	evidence_stage?: "collecting" | "reviewable";
	ambiguous?: false;
}

export interface CorrectionSplitModelProposal {
	proposal_id: string;
	kind: "correction_split";
	candidate_key: string;
	old_condition: string;
	old_behavior: string;
	new_condition: string;
	new_behavior: string;
	confidence_bp: number;
	source_refs: ModelOutputSourceRef[];
	evidence_summary?: string;
	evidence_stage?: "collecting" | "reviewable";
	ambiguous?: false;
}

export type ValidatedModelProposal = HabitCandidateModelProposal | CorrectionSplitModelProposal;

export interface ValidatedModelOutputBatch {
	schema_version: 1;
	user_id: string;
	file_generation: string;
	batch_id: string;
	model: string;
	created_at: string;
	seq_start: number;
	seq_end: number;
	read_checksum: string;
	proposals: ValidatedModelProposal[];
	checksum: string;
}

const MODEL_OUTPUT_KEYS = new Set(["schema_version", "user_id", "file_generation", "batch_id", "model", "created_at", "observations_read", "proposals"]);
const OBSERVATIONS_READ_KEYS = new Set(["seq_start", "seq_end", "checksum"]);
const HABIT_KEYS = new Set(["proposal_id", "kind", "candidate_key", "condition", "behavior", "polarity", "confidence_bp", "source_refs", "evidence_summary", "evidence_stage", "ambiguous"]);
const CORRECTION_KEYS = new Set(["proposal_id", "kind", "candidate_key", "old_condition", "old_behavior", "new_condition", "new_behavior", "confidence_bp", "source_refs", "evidence_summary", "evidence_stage", "ambiguous"]);
const REF_KEYS = new Set(["file_generation", "seq", "checksum"]);

function assertExactKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`${label} has unsupported field: ${key}`);
	}
}

function assertSafeToken(value: unknown, label: string, max = 160): string {
	if (typeof value !== "string" || value.length < 1 || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${label}`);
	return value;
}

function assertSafeText(value: unknown, label: string, max = 1000): string {
	const text = assertSafeToken(value, label, max);
	if (containsUnredactedSensitiveText(text)) throw new Error(`${label} contains unredacted sensitive text`);
	return text;
}

function assertGeneralizedHabitText(text: string, label: string): void {
	if (/\b(?:agent experience|pi-experiences|experience-consolidate)\b/i.test(text)) throw new Error(`${label} appears overfit to one project`);
	if (/\bv?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?\b/.test(text)) throw new Error(`${label} appears overfit to one version`);
	if (/(^|[\s("'`])(?:~\/|\.\.?\/|\/[A-Za-z0-9._-])/.test(text)) throw new Error(`${label} appears overfit to one file path`);
	if (/\b[a-f0-9]{12,}\b/i.test(text)) throw new Error(`${label} appears overfit to one hash or screenshot`);
}

function assertGeneration(value: unknown): string {
	const generation = assertSafeToken(value, "file_generation", 80);
	if (!/^[A-Za-z0-9._-]+$/.test(generation)) throw new Error("Invalid file_generation");
	return generation;
}

function assertChecksum(value: unknown, label = "checksum"): string {
	const checksum = assertSafeToken(value, label, 128);
	if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error(`Invalid ${label}`);
	return checksum;
}

function assertSeq(value: unknown, label: string): number {
	if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`Invalid ${label}`);
	return Number(value);
}

function assertConfidence(value: unknown): number {
	if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 10000) throw new Error("Invalid confidence_bp");
	return Number(value);
}

function validateSourceRef(value: unknown, expectedGeneration: string, seqStart: number, seqEnd: number): ModelOutputSourceRef {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid model source ref");
	const ref = value as Record<string, unknown>;
	assertExactKeys(ref, REF_KEYS, "model source ref");
	const fileGeneration = assertGeneration(ref.file_generation);
	if (fileGeneration !== expectedGeneration) throw new Error("Model source ref generation mismatch");
	const seq = assertSeq(ref.seq, "model source seq");
	if (seq < seqStart || seq > seqEnd) throw new Error("Model source ref outside read coverage");
	return { file_generation: fileGeneration, seq, checksum: assertChecksum(ref.checksum, "source checksum") };
}

function validateRefs(value: unknown, expectedGeneration: string, seqStart: number, seqEnd: number): ModelOutputSourceRef[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw new Error("Invalid model source_refs");
	return value.map((ref) => validateSourceRef(ref, expectedGeneration, seqStart, seqEnd));
}

export function validateModelOutputSourceRefs(output: ValidatedModelOutputBatch, observations: ValidatedObservationRecord[]): void {
	const byKey = new Map(observations.map((record) => [`${record.file_generation}:${record.seq}`, record]));
	for (const proposal of output.proposals) {
		for (const ref of proposal.source_refs) {
			const record = byKey.get(`${ref.file_generation}:${ref.seq}`);
			if (!record) throw new Error("Model source ref missing observation");
			if (record.user_id !== output.user_id || record.checksum !== ref.checksum) throw new Error("Model source ref checksum mismatch");
		}
	}
}

function validateProposal(value: unknown, seenIds: Set<string>, generation: string, seqStart: number, seqEnd: number): ValidatedModelProposal {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid model proposal");
	const proposal = value as Record<string, unknown>;
	if (proposal.ambiguous === true) throw new Error("Ambiguous model proposal");
	if (proposal.ambiguous !== undefined && proposal.ambiguous !== false) throw new Error("Invalid ambiguous flag");
	const kind = proposal.kind;
	if (kind !== "habit_candidate" && kind !== "correction_split") throw new Error("Unsupported model proposal kind");
	assertExactKeys(proposal, kind === "habit_candidate" ? HABIT_KEYS : CORRECTION_KEYS, "model proposal");
	const proposalId = assertSafeToken(proposal.proposal_id, "proposal_id");
	if (seenIds.has(proposalId)) throw new Error("Duplicate model proposal_id");
	seenIds.add(proposalId);
	const base = {
		proposal_id: proposalId,
		candidate_key: assertSafeToken(proposal.candidate_key, "candidate_key"),
		confidence_bp: assertConfidence(proposal.confidence_bp),
		source_refs: validateRefs(proposal.source_refs, generation, seqStart, seqEnd),
		...(proposal.evidence_summary === undefined ? {} : { evidence_summary: assertSafeText(proposal.evidence_summary, "evidence_summary") }),
		...(proposal.evidence_stage === undefined ? {} : { evidence_stage: proposal.evidence_stage === "collecting" || proposal.evidence_stage === "reviewable" ? proposal.evidence_stage : (() => { throw new Error("Invalid evidence_stage"); })() }),
		...(proposal.ambiguous === undefined ? {} : { ambiguous: false as const }),
	};
	if (kind === "habit_candidate") {
		if (proposal.polarity !== 1 && proposal.polarity !== -1) throw new Error("Invalid model polarity");
		const condition = assertSafeText(proposal.condition, "condition");
		const behavior = assertSafeText(proposal.behavior, "behavior");
		assertGeneralizedHabitText(condition, "condition");
		assertGeneralizedHabitText(behavior, "behavior");
		return { ...base, kind, condition, behavior, polarity: proposal.polarity };
	}
	const oldCondition = assertSafeText(proposal.old_condition, "old_condition");
	const oldBehavior = assertSafeText(proposal.old_behavior, "old_behavior");
	const newCondition = assertSafeText(proposal.new_condition, "new_condition");
	const newBehavior = assertSafeText(proposal.new_behavior, "new_behavior");
	assertGeneralizedHabitText(oldCondition, "old_condition");
	assertGeneralizedHabitText(oldBehavior, "old_behavior");
	assertGeneralizedHabitText(newCondition, "new_condition");
	assertGeneralizedHabitText(newBehavior, "new_behavior");
	if (oldCondition === newCondition && oldBehavior === newBehavior) throw new Error("Invalid correction_split replacement");
	return { ...base, kind, old_condition: oldCondition, old_behavior: oldBehavior, new_condition: newCondition, new_behavior: newBehavior };
}

export function validateModelOutputBatch(value: unknown, expectedUserId?: string): ValidatedModelOutputBatch {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid model output");
	const batch = value as Record<string, unknown>;
	assertExactKeys(batch, MODEL_OUTPUT_KEYS, "model output");
	if (batch.schema_version !== 1) throw new Error("Unsupported model output schema_version");
	const userId = normalizeUserId(assertSafeToken(batch.user_id, "user_id", 120));
	if (expectedUserId !== undefined && userId !== normalizeUserId(expectedUserId)) throw new Error("Model output user_id mismatch");
	const generation = assertGeneration(batch.file_generation);
	const createdAt = assertSafeToken(batch.created_at, "created_at", 80);
	if (Number.isNaN(Date.parse(createdAt))) throw new Error("Invalid model output created_at");
	if (!batch.observations_read || typeof batch.observations_read !== "object" || Array.isArray(batch.observations_read)) throw new Error("Invalid observations_read");
	const observationsRead = batch.observations_read as Record<string, unknown>;
	assertExactKeys(observationsRead, OBSERVATIONS_READ_KEYS, "observations_read");
	const seqStart = assertSeq(observationsRead.seq_start, "seq_start");
	const seqEnd = assertSeq(observationsRead.seq_end, "seq_end");
	if (seqEnd < seqStart) throw new Error("Invalid observations_read range");
	const readChecksum = assertChecksum(observationsRead.checksum, "observations_read checksum");
	if (!Array.isArray(batch.proposals) || batch.proposals.length > 200) throw new Error("Invalid model proposal list");
	const seenIds = new Set<string>();
	const proposals = batch.proposals.map((proposal) => validateProposal(proposal, seenIds, generation, seqStart, seqEnd));
	const normalized = {
		schema_version: 1 as const,
		user_id: userId,
		file_generation: generation,
		batch_id: assertSafeToken(batch.batch_id, "batch_id"),
		model: assertSafeToken(batch.model, "model", 120),
		created_at: createdAt,
		seq_start: seqStart,
		seq_end: seqEnd,
		read_checksum: readChecksum,
		proposals,
	};
	return { ...normalized, checksum: checksumJson({ schema: "agent_experience_model_output_v1", batch: JSON.parse(canonicalJson(normalized)) }) };
}

export function modelOutputToProposalBatch(batch: ValidatedModelOutputBatch): ProposalBatch {
	const proposals = batch.proposals.flatMap((proposal): ProposalBatch["proposals"] => {
		if (proposal.kind === "habit_candidate") {
			return [{
				proposal_id: proposal.proposal_id,
				kind: "habit_candidate",
				candidate_key: proposal.candidate_key,
				condition: proposal.condition,
				behavior: proposal.behavior,
				polarity: proposal.polarity,
				confidence_bp: proposal.confidence_bp,
				source_refs: proposal.source_refs,
				...(proposal.evidence_summary === undefined ? {} : { evidence_summary: proposal.evidence_summary }),
				...(proposal.evidence_stage === undefined ? {} : { evidence_stage: proposal.evidence_stage }),
			}];
		}
		return [
			{
				proposal_id: `${proposal.proposal_id}-old-negative`,
				kind: "habit_candidate",
				candidate_key: `${proposal.candidate_key}:old`,
				condition: proposal.old_condition,
				behavior: proposal.old_behavior,
				polarity: -1,
				confidence_bp: proposal.confidence_bp,
				source_refs: proposal.source_refs,
				...(proposal.evidence_summary === undefined ? {} : { evidence_summary: proposal.evidence_summary }),
				correction_role: "old_negative",
				correction_group_id: proposal.proposal_id,
				...(proposal.evidence_stage === undefined ? {} : { evidence_stage: proposal.evidence_stage }),
			},
			{
				proposal_id: `${proposal.proposal_id}-new-positive`,
				kind: "habit_candidate",
				candidate_key: `${proposal.candidate_key}:new`,
				condition: proposal.new_condition,
				behavior: proposal.new_behavior,
				polarity: 1,
				confidence_bp: proposal.confidence_bp,
				source_refs: proposal.source_refs,
				...(proposal.evidence_summary === undefined ? {} : { evidence_summary: proposal.evidence_summary }),
				correction_role: "replacement",
				correction_group_id: proposal.proposal_id,
				...(proposal.evidence_stage === undefined ? {} : { evidence_stage: proposal.evidence_stage }),
			},
		];
	});
	return { schema_version: 1, user_id: batch.user_id, batch_id: batch.batch_id, created_at: batch.created_at, proposals };
}

function stableId(prefix: string, value: unknown): string {
	return `${prefix}-${sha256Hex(canonicalJson(value)).slice(0, 40)}`;
}

function quarantineRowChecksum(row: { user_id: string; file_generation: string; seq_start: number; seq_end: number; reason: string; model: string; output_json: string; checksum: string; created_at: string }): string {
	return checksumJson({ table: "model_output_quarantine", row });
}

function pendingReviewChecksum(row: { user_id: string; kind: string; status: string; payload_json: string }): string {
	return checksumJson({ table: "pending_review", row });
}

export function insertPendingReview(db: any, input: { userId: string; kind: string; payload: unknown; createdAt: string }): { id: string; inserted: boolean; checksum: string } {
	const userId = normalizeUserId(input.userId);
	const payload = redactJson(input.payload ?? {});
	const payloadJson = canonicalJson(payload);
	if (payloadJson.length > 24000) throw new Error("Pending review payload too large");
	const checksum = pendingReviewChecksum({ user_id: userId, kind: input.kind, status: "open", payload_json: payloadJson });
	const id = stableId("pending", { user_id: userId, kind: input.kind, checksum });
	const existing = db.prepare("SELECT id, checksum FROM pending_review WHERE id = ?").get(id);
	if (existing) {
		if (existing.checksum !== checksum) throw new Error("Pending review stable id collision");
		return { id, inserted: false, checksum };
	}
	db.prepare("INSERT INTO pending_review (id, user_id, kind, status, payload_json, checksum, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?, ?, ?)")
		.run(id, userId, input.kind, payloadJson, checksum, input.createdAt, input.createdAt);
	return { id, inserted: true, checksum };
}

export function insertModelOutputQuarantine(db: any, input: { userId: string; fileGeneration: string; seqStart: number; seqEnd: number; reason: string; model: string; output: unknown; createdAt: string }): { id: string; inserted: boolean; checksum: string } {
	const userId = normalizeUserId(input.userId);
	if (!Number.isInteger(input.seqStart) || !Number.isInteger(input.seqEnd) || input.seqStart < 1 || input.seqEnd < input.seqStart) throw new Error("Invalid quarantine range");
	const redacted = redactJson(input.output ?? {});
	const outputJson = canonicalJson(redacted);
	if (outputJson.length > 24000) throw new Error("Quarantine output too large");
	const checksum = checksumJson({ schema: "agent_experience_model_output_quarantine_v1", output: JSON.parse(outputJson) });
	const id = stableId("quarantine", { user_id: userId, file_generation: input.fileGeneration, seq_start: input.seqStart, seq_end: input.seqEnd, reason: input.reason, checksum });
	const rowChecksum = quarantineRowChecksum({ user_id: userId, file_generation: input.fileGeneration, seq_start: input.seqStart, seq_end: input.seqEnd, reason: input.reason, model: input.model, output_json: outputJson, checksum, created_at: input.createdAt });
	const existing = db.prepare("SELECT id, checksum, row_checksum FROM model_output_quarantine WHERE id = ?").get(id);
	if (existing) {
		if (existing.checksum !== checksum || existing.row_checksum !== rowChecksum) throw new Error("Quarantine stable id collision");
		return { id, inserted: false, checksum };
	}
	db.prepare("INSERT INTO model_output_quarantine (id, user_id, file_generation, seq_start, seq_end, reason, model, output_json, checksum, created_at, row_checksum) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.run(id, userId, input.fileGeneration, input.seqStart, input.seqEnd, input.reason, input.model, outputJson, checksum, input.createdAt, rowChecksum);
	return { id, inserted: true, checksum };
}

function normalizedIdentityText(value: string): string {
	return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function proposalIdentityForConflict(proposal: ValidatedModelProposal): string {
	if (proposal.kind === "habit_candidate") return canonicalJson({ kind: proposal.kind, condition: normalizedIdentityText(proposal.condition), behavior: normalizedIdentityText(proposal.behavior), polarity: proposal.polarity });
	return canonicalJson({ kind: proposal.kind, old_condition: normalizedIdentityText(proposal.old_condition), old_behavior: normalizedIdentityText(proposal.old_behavior), new_condition: normalizedIdentityText(proposal.new_condition), new_behavior: normalizedIdentityText(proposal.new_behavior) });
}

function findCandidateKeyConflict(output: ValidatedModelOutputBatch): { candidate_key: string; identities: string[] } | null {
	const byKey = new Map<string, Set<string>>();
	for (const proposal of output.proposals) {
		const set = byKey.get(proposal.candidate_key) || new Set<string>();
		set.add(proposalIdentityForConflict(proposal));
		byKey.set(proposal.candidate_key, set);
	}
	for (const [candidate_key, identities] of byKey) {
		if (identities.size > 1) return { candidate_key, identities: [...identities].sort() };
	}
	return null;
}

export async function processValidatedModelOutput(input: { db: any; userId: string; output: ValidatedModelOutputBatch; observations: ValidatedObservationRecord[]; expectedRange?: { file_generation: string; seq_start: number; seq_end: number; read_checksum: string }; semantic?: Parameters<typeof consolidateProposalBatch>[0]["semantic"] }): Promise<ConsolidationResult | { user_id: string; file_generation: string; candidate_ids: []; evidence_ids: []; watermark_after: null; read_watermark_after?: unknown; pending_review_id?: string; inserted: { read_watermark?: 0 | 1; pending_review?: 0 | 1 } }> {
	const userId = normalizeUserId(input.userId);
	if (input.output.user_id !== userId) throw new Error("Model output user mismatch");
	validateModelOutputSourceRefs(input.output, input.observations);
	if (input.expectedRange) {
		if (input.output.file_generation !== input.expectedRange.file_generation || input.output.seq_start !== input.expectedRange.seq_start || input.output.seq_end !== input.expectedRange.seq_end || input.output.read_checksum !== input.expectedRange.read_checksum) throw new Error("Model output expected range mismatch");
	}
	const sourceLast = input.observations.find((record) => record.file_generation === input.output.file_generation && record.seq === input.output.seq_end);
	if (!sourceLast || sourceLast.checksum !== input.output.read_checksum) throw new Error("Model output read coverage mismatch");
	const conflict = findCandidateKeyConflict(input.output);
	if (conflict) {
		let pending: { id: string; inserted: boolean } | undefined;
		let readCoverage: ReturnType<typeof recordProposalReadCoverageInTransaction> | undefined;
		input.db.exec("BEGIN IMMEDIATE");
		try {
			pending = insertPendingReview(input.db, { userId, kind: "candidate_key_conflict", payload: { file_generation: input.output.file_generation, seq_start: input.output.seq_start, seq_end: input.output.seq_end, conflict }, createdAt: input.output.created_at });
			readCoverage = recordProposalReadCoverageInTransaction({ db: input.db, userId, fileGeneration: input.output.file_generation, seqStart: input.output.seq_start, last: sourceLast, createdAt: input.output.created_at });
			input.db.exec("COMMIT");
		} catch (error) {
			try { input.db.exec("ROLLBACK"); } catch {}
			throw error;
		}
		return { user_id: userId, file_generation: input.output.file_generation, candidate_ids: [], evidence_ids: [], watermark_after: null, read_watermark_after: readCoverage.watermark_after, pending_review_id: pending.id, inserted: { pending_review: pending.inserted ? 1 : 0, read_watermark: readCoverage.inserted.read_watermark } };
	}
	if (input.output.proposals.length === 0) {
		const zero = recordZeroProposalReadCoverage({ db: input.db, userId, fileGeneration: input.output.file_generation, seqStart: input.output.seq_start, last: sourceLast, createdAt: input.output.created_at });
		return { user_id: userId, file_generation: input.output.file_generation, candidate_ids: [], evidence_ids: [], watermark_after: null, read_watermark_after: zero.watermark_after, inserted: zero.inserted };
	}
	return consolidateProposalBatch({ db: input.db, userId, proposalBatch: modelOutputToProposalBatch(input.output), observations: input.observations, readCoverage: { seq_start: input.output.seq_start, last: sourceLast }, semantic: input.semantic });
}
