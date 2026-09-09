import { canonicalJson, sha256Hex } from "../storage/checksum.ts";
import { acquireOwnedLock } from "../storage/locks.ts";
import { normalizeUserId } from "../storage/private-root.ts";
import type { AgentExperienceConfig } from "../config.ts";
import { createEmbeddingAdapterFromConfig, semanticPolicyFromConfig } from "../semantic/config.ts";
import { sanitizePolicy } from "../semantic/service.ts";
import type { EmbeddingAdapter, SemanticDedupePolicy } from "../semantic/types.ts";
import type { ExperienceHost } from "../experience/types.ts";
import type { ValidatedObservationRecord } from "./observations.ts";
import { validateModelOutputBatch, validateModelOutputSourceRefs, modelOutputToProposalBatch, insertModelOutputQuarantine, processValidatedModelOutput, type ValidatedModelOutputBatch } from "./model-output.ts";
import { buildCompactHabitContext } from "./context.ts";
import { isAssessmentValidatedModelOutput, normalizeConsolidationModelOutput } from "./model-adapter.ts";
import { assertSituationBatch, buildSituationBatch, validateSituationEvidenceForProposal, type SituationBatch } from "./situations.ts";

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
	if (output.proposals.some((proposal) => "applicability" in proposal)) {
		const proposals = output.proposals.map((proposal) => "applicability" in proposal
			? { kind: proposal.kind, applicability: proposal.applicability, content: proposal.content, confidence_bp: proposal.confidence_bp, source_ref_count: proposal.source_refs.length }
			: { kind: proposal.kind, candidate_key: proposal.candidate_key, confidence_bp: proposal.confidence_bp, source_ref_count: proposal.source_refs.length });
		return {
			user_id: output.user_id,
			file_generation: output.file_generation,
			seq_start: output.seq_start,
			seq_end: output.seq_end,
			model: output.model,
			proposal_count: proposals.length,
			proposals,
			checksum: sha256Hex(canonicalJson(proposals)),
		};
	}
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

export async function runConsolidationOnce(input: { root: string; db: any; userId: string; observations: ValidatedObservationRecord[]; modelOutput: unknown; model: string; host?: ExperienceHost; config?: AgentExperienceConfig; situationBatch?: SituationBatch; semantic?: { policy?: Partial<SemanticDedupePolicy>; provider?: EmbeddingAdapter; signal?: AbortSignal }; dryRun?: boolean; now?: string }) {
	const userId = normalizeUserId(input.userId);
	const createdAt = input.now || new Date().toISOString();
	const lock = await acquireConsolidationLock(input.root, { owner: "experience-consolidate", createdAt });
	let ownedEmbeddingProvider: any;
	try {
		const expected = expectedRangeFromObservations(input.observations, userId);
		const before = tableCounts(input.db);
		const authoritativeSituationBatch = buildSituationBatch(input.db, {
			userId,
			observations: input.observations,
			retentionDays: input.config?.observation_retention_days ?? 7,
			now: createdAt,
		});
		if (input.situationBatch) {
			assertSituationBatch(input.situationBatch, { userId, fileGeneration: expected.file_generation, seqStart: expected.seq_start, seqEnd: expected.seq_end });
			if (input.situationBatch.checksum !== authoritativeSituationBatch.checksum) throw new Error("Situation batch differs from authoritative runner snapshot");
		}
		const hasCausalInput = input.observations.some((record) => {
			const payload = record.payload_redacted as any;
			return payload?.kind === "conversation_pair_v1" && payload.causal_context !== undefined;
		});
		const requireSituationContract = !!input.config || hasCausalInput;
		const situationBatch = requireSituationContract ? authoritativeSituationBatch : undefined;
		let output: ValidatedModelOutputBatch;
		try {
			let candidateOutput = input.modelOutput;
			if (situationBatch && !isAssessmentValidatedModelOutput(candidateOutput)) {
				candidateOutput = normalizeConsolidationModelOutput(candidateOutput as any, {
					model: input.model,
					userId,
					observations: input.observations,
					habitContext: buildCompactHabitContext(input.db, { userId, limit: 60 }),
					expected,
					situationBatch,
				}, { habitsOnly: true });
			}
			if (situationBatch && !isAssessmentValidatedModelOutput(candidateOutput)) throw new Error("habit_learning_model_missing_assessment_proof");
			output = validateModelOutputBatch(candidateOutput, userId);
			validateModelOutputExpectedRange(output, expected);
			validateModelOutputSourceRefs(output, input.observations);
			if (situationBatch) for (const proposal of output.proposals) validateSituationEvidenceForProposal(proposal, situationBatch);
		} catch (error: any) {
			if (!input.dryRun) {
				const quarantineOutput = situationBatch
					? { contract: "situation_assessment_v1", validation: "rejected", proposal_count: Array.isArray((input.modelOutput as any)?.proposals) ? Math.min((input.modelOutput as any).proposals.length, 200) : 0 }
					: input.modelOutput;
				insertModelOutputQuarantine(input.db, { userId, fileGeneration: expected.file_generation, seqStart: expected.seq_start, seqEnd: expected.seq_end, reason: "model_output_invalid", model: input.model, output: quarantineOutput, createdAt });
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
		const result = await processValidatedModelOutput({ db: input.db, userId, output, observations: input.observations, host: input.host, expectedRange: expected, situationBatch, semantic });
		return { ok: true, dry_run: false, expected, diff, result, before, after: tableCounts(input.db) };
	} finally {
		await ownedEmbeddingProvider?.close?.().catch(() => undefined);
		await lock.release();
	}
}
