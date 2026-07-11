import { canonicalJson, sha256Hex } from "../storage/checksum.ts";
import { acquireOwnedLock } from "../storage/locks.ts";
import { normalizeUserId } from "../storage/private-root.ts";
import type { AgentExperienceConfig } from "../config.ts";
import { createEmbeddingAdapterFromConfig, semanticPolicyFromConfig } from "../semantic/config.ts";
import { sanitizePolicy } from "../semantic/service.ts";
import type { EmbeddingAdapter, SemanticDedupePolicy } from "../semantic/types.ts";
import type { ValidatedObservationRecord } from "./observations.ts";
import { validateModelOutputBatch, validateModelOutputSourceRefs, modelOutputToProposalBatch, insertModelOutputQuarantine, processValidatedModelOutput, type ValidatedModelOutputBatch } from "./model-output.ts";

export interface ConsolidationExpectedRange {
	user_id: string;
	file_generation: string;
	seq_start: number;
	seq_end: number;
	read_checksum: string;
}

export interface ConsolidationLock {
	path: string;
	release(): Promise<void>;
}

export async function acquireConsolidationLock(root: string, _input: { owner?: string; createdAt?: string } = {}): Promise<ConsolidationLock> {
	try {
		return await acquireOwnedLock(root, "consolidate", { waitMs: 0, staleMs: 2 * 60 * 60_000 });
	} catch (error: any) {
		if (/Could not acquire/.test(String(error?.message || error))) throw new Error("consolidation_lock_active");
		throw error;
	}
}

export function expectedRangeFromObservations(observations: ValidatedObservationRecord[], userId: string): ConsolidationExpectedRange {
	const normalizedUserId = normalizeUserId(userId);
	if (!Array.isArray(observations) || observations.length < 1) throw new Error("No observations to consolidate");
	const first = observations[0];
	const last = observations.at(-1)!;
	const generation = first.file_generation;
	for (let index = 0; index < observations.length; index += 1) {
		const record = observations[index];
		if (record.user_id !== normalizedUserId) throw new Error("Observation user mismatch");
		if (record.file_generation !== generation) throw new Error("Observation generation mismatch");
		if (record.seq !== first.seq + index) throw new Error("Observation batch range is not contiguous");
	}
	return { user_id: normalizedUserId, file_generation: generation, seq_start: first.seq, seq_end: last.seq, read_checksum: last.checksum };
}

export function validateModelOutputExpectedRange(output: ValidatedModelOutputBatch, expected: ConsolidationExpectedRange): void {
	if (output.user_id !== expected.user_id) throw new Error("Model output expected user mismatch");
	if (output.file_generation !== expected.file_generation) throw new Error("Model output expected generation mismatch");
	if (output.seq_start !== expected.seq_start || output.seq_end !== expected.seq_end || output.read_checksum !== expected.read_checksum) throw new Error("Model output read range mismatch");
}

function summarizeProposalDiff(output: ValidatedModelOutputBatch) {
	const batch = modelOutputToProposalBatch(output);
	return {
		user_id: output.user_id,
		file_generation: output.file_generation,
		seq_start: output.seq_start,
		seq_end: output.seq_end,
		model: output.model,
		proposal_count: batch.proposals.length,
		proposals: batch.proposals.map((proposal) => ({ kind: proposal.kind, condition: proposal.condition, behavior: proposal.behavior, polarity: proposal.polarity, confidence_bp: proposal.confidence_bp, source_ref_count: proposal.source_refs.length })),
		checksum: sha256Hex(canonicalJson(batch)),
	};
}

function tableCounts(db: any): Record<string, number> {
	const tables = ["habits", "evidence", "pending_review", "model_output_quarantine", "consolidation_audit", "consolidation_watermarks", "proposal_read_watermarks", "selector_hit_log"];
	return Object.fromEntries(tables.map((table) => [table, Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)]));
}

export async function runConsolidationOnce(input: { root: string; db: any; userId: string; observations: ValidatedObservationRecord[]; modelOutput: unknown; model: string; config?: AgentExperienceConfig; semantic?: { policy?: Partial<SemanticDedupePolicy>; provider?: EmbeddingAdapter; signal?: AbortSignal }; dryRun?: boolean; now?: string }) {
	const userId = normalizeUserId(input.userId);
	const createdAt = input.now || new Date().toISOString();
	const lock = await acquireConsolidationLock(input.root, { owner: "experience-consolidate", createdAt });
	let ownedEmbeddingProvider: any;
	try {
		const expected = expectedRangeFromObservations(input.observations, userId);
		const before = tableCounts(input.db);
		let output: ValidatedModelOutputBatch;
		try {
			output = validateModelOutputBatch(input.modelOutput, userId);
			validateModelOutputExpectedRange(output, expected);
			validateModelOutputSourceRefs(output, input.observations);
		} catch (error: any) {
			if (!input.dryRun) {
				insertModelOutputQuarantine(input.db, { userId, fileGeneration: expected.file_generation, seqStart: expected.seq_start, seqEnd: expected.seq_end, reason: "read_range_mismatch", model: input.model, output: input.modelOutput, createdAt });
			}
			return { ok: false, dry_run: !!input.dryRun, reason: String(error?.message || "model_output_invalid"), quarantined: !input.dryRun, expected, before, after: tableCounts(input.db) };
		}
		const diff = summarizeProposalDiff(output);
		if (input.dryRun) {
			return { ok: true, dry_run: true, expected, diff, before, after: tableCounts(input.db) };
		}
		const semanticPolicy = input.semantic?.policy ? sanitizePolicy(input.semantic.policy) : input.config ? semanticPolicyFromConfig(input.config) : undefined;
		let semantic: Parameters<typeof processValidatedModelOutput>[0]["semantic"] | undefined;
		if (semanticPolicy?.enabled) {
			let provider = input.semantic?.provider;
			try {
				if (!provider) ownedEmbeddingProvider = provider = createEmbeddingAdapterFromConfig(input.config!, input.root);
			} catch (error: any) {
				return { ok: false, dry_run: false, reason: "semantic_embedding_provider_unavailable", detail: String(error?.message || error).slice(0, 300), expected, diff, before, after: tableCounts(input.db) };
			}
			if (!provider) return { ok: false, dry_run: false, reason: "semantic_embedding_provider_unavailable", expected, diff, before, after: tableCounts(input.db) };
			semantic = { policy: semanticPolicy, provider, signal: input.semantic?.signal };
		}
		const result = await processValidatedModelOutput({ db: input.db, userId, output, observations: input.observations, expectedRange: expected, semantic });
		return { ok: true, dry_run: false, expected, diff, result, before, after: tableCounts(input.db) };
	} finally {
		await ownedEmbeddingProvider?.close?.().catch(() => undefined);
		await lock.release();
	}
}
