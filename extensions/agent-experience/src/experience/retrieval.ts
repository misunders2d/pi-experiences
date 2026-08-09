import type { DatabaseSync } from "node:sqlite";
import type { AgentExperienceConfig } from "../config.ts";
import { maxHabitFieldSimilarityBp, SELECTOR_VECTOR_RETRIEVAL_FLOOR_BP } from "../selector-vector.ts";
import { normalizedVector } from "../semantic/core.ts";
import { semanticPolicyFromConfig } from "../semantic/config.ts";
import { prepareHabitFieldEmbeddings } from "../semantic/service.ts";
import { getCachedHabitFieldEmbeddingsBatch, upsertCachedHabitEmbedding } from "../semantic/storage.ts";
import type { EmbeddingAdapter, SemanticHabitRow } from "../semantic/types.ts";
import { canonicalJson } from "../storage/checksum.ts";
import { normalizeUserId } from "../storage/private-root.ts";
import { redactText } from "../storage/redaction.ts";
import { experienceApprovalIdentity, isExperienceEligible, validateExperienceRecord } from "./schema.ts";
import { getExperience, listEligibleExperiences } from "./storage.ts";
import type { ExperienceKind, ExperienceRecordV1 } from "./types.ts";

const MAX_EXPERIENCE_CANDIDATES = 8;
const MAX_ACTIVE_REQUEST_EXPERIENCES = 8;
const MAX_EXPERIENCE_SCAN = 100;
const MAX_CONTEXT_PACK_CHARS = 6_000;
const MAX_CONTEXT_FIELD_CHARS = 1_500;
const MAX_CONTEXT_RATIONALE_CHARS = 800;
const MAX_CONTEXT_EXCEPTIONS = 4;
const MAX_CONTEXT_EXCEPTION_CHARS = 400;

export type ExperienceReviewerTarget = "advisor" | "assistant_context";

export interface ExperienceRetrievalCandidate {
	alias: string;
	experience: ExperienceRecordV1;
	approvalIdentity: string;
	similarityBp: number;
	reviewerTargets: ExperienceReviewerTarget[];
}

export interface ExperienceContextPack {
	summary: string;
	modelPayload: Array<{
		alias: string;
		kind: ExperienceKind;
		scope: { kind: ExperienceRecordV1["scope"]["kind"] };
		authority: ExperienceRecordV1["authority"];
		applicability: string;
		content: string;
		rationale?: string;
		exceptions: string[];
	}>;
}

export interface CurrentExperienceScope {
	runtime?: string;
	workspace?: string;
	repository?: string;
	project?: string;
}

function reviewerTargets(kind: ExperienceKind): ExperienceReviewerTarget[] {
	return kind === "habit" ? ["advisor"] : ["assistant_context"];
}

function semanticRow(record: ExperienceRecordV1): SemanticHabitRow {
	return {
		id: record.id,
		user_id: record.userId,
		status: record.status,
		condition: record.applicability,
		behavior: record.content,
		polarity: 1,
		checksum: record.checksum,
		created_at: record.validFrom,
		updated_at: record.lastConfirmedAt,
		data_json: canonicalJson(record),
	};
}

function approvedIdentity(record: ExperienceRecordV1): string | undefined {
	return record.status === "active" ? canonicalJson(experienceApprovalIdentity(record)) : undefined;
}

function eligibleRecords(db: DatabaseSync, input: {
	userId: string;
	now: string;
	config: AgentExperienceConfig;
	kinds?: ExperienceKind[];
	currentScope?: CurrentExperienceScope;
	includeAllScopes?: boolean;
}): ExperienceRecordV1[] {
	const allowed = input.kinds ? new Set(input.kinds) : undefined;
	return listEligibleExperiences(db, { userId: input.userId, now: input.now })
		.filter(record => !allowed || allowed.has(record.kind))
		.filter(record => input.includeAllScopes || record.scope.kind === "user" || input.currentScope?.[record.scope.kind] === record.scope.key)
		.filter(record => record.confidenceBp >= input.config.selector_min_confidence_bp)
		.filter(record => approvedIdentity(record) !== undefined)
		.slice(0, MAX_EXPERIENCE_SCAN);
}

function assertEnabled(config: AgentExperienceConfig): void {
	if (!config.enabled || (!config.embedding_enabled && !config.advisor_enabled)) throw new Error("experience_vectors_disabled");
}

export async function prepareExperienceVectors(db: DatabaseSync, input: {
	userId: string;
	now: string;
	config: AgentExperienceConfig;
	embeddingAdapter: EmbeddingAdapter;
	kinds?: ExperienceKind[];
	signal?: AbortSignal;
}): Promise<{ total: number; cached: number; prepared: number }> {
	assertEnabled(input.config);
	const userId = normalizeUserId(input.userId);
	const selected = eligibleRecords(db, { ...input, userId, includeAllScopes: true });
	if (!selected.length) return { total: 0, cached: 0, prepared: 0 };
	const policy = semanticPolicyFromConfig(input.config);
	const prepared = await prepareHabitFieldEmbeddings(db, {
		userId,
		habits: selected.map(semanticRow),
		policy,
		provider: input.embeddingAdapter,
		signal: input.signal,
	});
	const cached = [...prepared.values()].filter(item => item.condition.cached && item.behavior.cached).length;
	db.exec("BEGIN IMMEDIATE");
	try {
		if (input.signal?.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new Error("experience_cancelled");
		for (const original of selected) {
			const current = getExperience(db, { userId, id: original.id });
			if (!current || current.checksum !== original.checksum || !isExperienceEligible(current, { userId, now: input.now }) || approvedIdentity(current) !== approvedIdentity(original)) throw new Error("experience_snapshot_changed");
			const fields = prepared.get(original.id);
			if (!fields || fields.habit.checksum !== original.checksum) throw new Error("experience_snapshot_changed");
			for (const field of [fields.condition, fields.behavior]) {
				if (field.cached) continue;
				upsertCachedHabitEmbedding(db, {
					userId,
					habitId: original.id,
					embeddingInputVersion: field.embeddingInputVersion,
					embeddingInputChecksum: field.embeddingInputChecksum,
					habitRowChecksum: original.checksum,
					provider: policy.provider,
					model: policy.model,
					dimensions: policy.dimensions,
					vector: field.vector,
					now: input.now,
				});
			}
		}
		db.exec("COMMIT");
	} catch (error) {
		try { db.exec("ROLLBACK"); } catch {}
		throw error;
	}
	return { total: selected.length, cached, prepared: selected.length - cached };
}

export async function retrieveExperienceCandidates(db: DatabaseSync, input: {
	userId: string;
	now: string;
	query: string;
	activeRequestExperienceIds?: string[];
	config: AgentExperienceConfig;
	embeddingAdapter: EmbeddingAdapter;
	kinds?: ExperienceKind[];
	signal?: AbortSignal;
	currentScope?: CurrentExperienceScope;
}): Promise<ExperienceRetrievalCandidate[]> {
	assertEnabled(input.config);
	const userId = normalizeUserId(input.userId);
	const eligible = eligibleRecords(db, { ...input, userId });
	const byId = new Map(eligible.map(record => [record.id, record]));
	const candidates: ExperienceRetrievalCandidate[] = [];
	for (const id of new Set(input.activeRequestExperienceIds || [])) {
		const experience = byId.get(id);
		const identity = experience && approvedIdentity(experience);
		if (!experience || !identity) continue;
		candidates.push({ alias: "", experience, approvalIdentity: identity, similarityBp: 10_000, reviewerTargets: reviewerTargets(experience.kind) });
		if (candidates.length >= MAX_ACTIVE_REQUEST_EXPERIENCES) break;
	}
	try {
		const queryVectors = await input.embeddingAdapter.embed([redactText(input.query).slice(0, 8_000)], { signal: input.signal });
		if (queryVectors.length !== 1 || queryVectors[0].length !== input.embeddingAdapter.dimensions) throw new Error("experience_query_embedding_invalid");
		const vectors = getCachedHabitFieldEmbeddingsBatch(db, {
			userId,
			provider: input.embeddingAdapter.provider,
			model: input.embeddingAdapter.model,
			dimensions: input.embeddingAdapter.dimensions,
			expectations: eligible.map(record => ({ habitId: record.id, habitRowChecksum: record.checksum, condition: record.applicability, behavior: record.content })),
		});
		if (vectors.missingIds.length || vectors.invalidIds.length || vectors.embeddings.size !== eligible.length) throw new Error("experience_vectors_unavailable");
		const queryVector = normalizedVector(queryVectors[0]);
		const ranked = eligible.map(experience => {
			const fields = vectors.embeddings.get(experience.id);
			if (!fields) throw new Error("experience_vectors_unavailable");
			return {
				alias: "",
				experience,
				approvalIdentity: approvedIdentity(experience)!,
				similarityBp: maxHabitFieldSimilarityBp(queryVector, fields.condition.vector, fields.behavior.vector),
				reviewerTargets: reviewerTargets(experience.kind),
			};
		}).filter(candidate => candidate.similarityBp >= SELECTOR_VECTOR_RETRIEVAL_FLOOR_BP)
			.sort((left, right) => right.similarityBp - left.similarityBp || left.experience.id.localeCompare(right.experience.id));
		const seen = new Set(candidates.map(candidate => candidate.experience.id));
		for (const candidate of ranked) {
			if (seen.has(candidate.experience.id)) continue;
			seen.add(candidate.experience.id);
			candidates.push(candidate);
			if (candidates.length >= MAX_EXPERIENCE_CANDIDATES) break;
		}
	} catch {
		// Missing optional vectors fail closed to already-active request experiences.
	}
	return candidates.slice(0, MAX_EXPERIENCE_CANDIDATES).map((candidate, index) => ({ ...candidate, alias: `e${index + 1}` }));
}

export function buildExperienceContextPack(candidates: ExperienceRetrievalCandidate[], target: ExperienceReviewerTarget | "all"): ExperienceContextPack {
	const selected = target === "all" ? candidates : candidates.filter(candidate => candidate.reviewerTargets.includes(target));
	const modelPayload: ExperienceContextPack["modelPayload"] = [];
	let payloadChars = 2;
	for (const candidate of selected) {
		const experience = candidate.experience;
		const entry = {
			alias: candidate.alias,
			kind: experience.kind,
			scope: { kind: experience.scope.kind },
			authority: experience.authority,
			applicability: redactText(experience.applicability).slice(0, MAX_CONTEXT_FIELD_CHARS),
			content: redactText(experience.content).slice(0, MAX_CONTEXT_FIELD_CHARS),
			...(experience.rationale === undefined ? {} : { rationale: redactText(experience.rationale).slice(0, MAX_CONTEXT_RATIONALE_CHARS) }),
			exceptions: experience.exceptions.slice(0, MAX_CONTEXT_EXCEPTIONS).map(value => redactText(value).slice(0, MAX_CONTEXT_EXCEPTION_CHARS)),
		};
		const entryChars = JSON.stringify(entry).length + (modelPayload.length ? 1 : 0);
		if (payloadChars + entryChars > MAX_CONTEXT_PACK_CHARS) break;
		modelPayload.push(entry);
		payloadChars += entryChars;
	}
	return {
		summary: modelPayload.map(entry => `${entry.kind}: ${entry.applicability} — ${entry.content}`).join("\n").slice(0, MAX_CONTEXT_PACK_CHARS),
		modelPayload,
	};
}

export function revalidateExperienceCandidate(db: DatabaseSync, input: {
	userId: string;
	now: string;
	alias: string;
	candidates: ExperienceRetrievalCandidate[];
	config: AgentExperienceConfig;
}): ExperienceRecordV1 {
	assertEnabled(input.config);
	const expected = input.candidates.find(candidate => candidate.alias === input.alias);
	if (!expected) throw new Error("experience_snapshot_changed");
	const userId = normalizeUserId(input.userId);
	const current = getExperience(db, { userId, id: expected.experience.id });
	if (!current || current.checksum !== expected.experience.checksum || approvedIdentity(current) !== expected.approvalIdentity || !isExperienceEligible(current, { userId, now: input.now })) throw new Error("experience_snapshot_changed");
	if (current.confidenceBp < input.config.selector_min_confidence_bp) throw new Error("experience_snapshot_changed");
	return validateExperienceRecord(current);
}
