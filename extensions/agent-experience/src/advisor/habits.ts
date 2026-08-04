import type { DatabaseSync } from "node:sqlite";
import type { AgentExperienceConfig } from "../config.ts";
import { revalidateLawSnapshotSync, type LawSnapshot } from "../review.ts";
import { assertValidHabitStorageRow, filterEligibleSelectorCandidates, selectorCandidateFromRow, type SelectorCandidate } from "../selector.ts";
import { maxHabitFieldSimilarityBp, MAX_SELECTOR_ELIGIBLE_HABITS, SELECTOR_VECTOR_RETRIEVAL_FLOOR_BP } from "../selector-vector.ts";
import { normalizeSemanticText, normalizedVector } from "../semantic/core.ts";
import { semanticPolicyFromConfig } from "../semantic/config.ts";
import { prepareHabitFieldEmbeddings } from "../semantic/service.ts";
import { getCachedHabitFieldEmbeddingsBatch, upsertCachedHabitEmbedding } from "../semantic/storage.ts";
import type { EmbeddingAdapter, SemanticHabitRow } from "../semantic/types.ts";
import { normalizeUserId } from "../storage/private-root.ts";
import { prepareAdvisorRetrievalQuery } from "./retrieval-query.ts";
import type { AdvisorHabitCandidate, AdvisorPrimaryDelta } from "./types.ts";

const MAX_ADVISOR_HABIT_CANDIDATES = 8;
const MAX_ACTIVE_REQUEST_HABIT_IDS = 8;

interface HabitStorageRow {
	id: string;
	user_id: string;
	record_kind: string;
	schema_version: number;
	status: string;
	habit_id: string | null;
	condition: string | null;
	behavior: string | null;
	polarity: number;
	confidence_bp: number;
	activation: number;
	staleness: number;
	data_json: string;
	checksum: string;
	created_at: string;
	updated_at: string;
}

export interface AdvisorHabitRetrievalCandidate extends AdvisorHabitCandidate {
	confidenceBp: number;
	staleness: number;
	approvalIdentity: string;
	responseGeneration: number;
	cursor: number;
	advisorEpoch: number;
	similarityBp: number;
}

function isHabitStorageRow(value: unknown): value is HabitStorageRow {
	if (!value || typeof value !== "object") return false;
	return "id" in value && typeof value.id === "string"
		&& "user_id" in value && typeof value.user_id === "string"
		&& "record_kind" in value && typeof value.record_kind === "string"
		&& "schema_version" in value && typeof value.schema_version === "number"
		&& "status" in value && typeof value.status === "string"
		&& "condition" in value && (typeof value.condition === "string" || value.condition === null)
		&& "behavior" in value && (typeof value.behavior === "string" || value.behavior === null)
		&& "polarity" in value && typeof value.polarity === "number"
		&& "confidence_bp" in value && typeof value.confidence_bp === "number"
		&& "activation" in value && typeof value.activation === "number"
		&& "staleness" in value && typeof value.staleness === "number"
		&& "data_json" in value && typeof value.data_json === "string"
		&& "checksum" in value && typeof value.checksum === "string"
		&& "created_at" in value && typeof value.created_at === "string"
		&& "updated_at" in value && typeof value.updated_at === "string";
}

function parseData(row: HabitStorageRow): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(row.data_json);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...parsed } : {};
	} catch {
		return {};
	}
}

function approvedIdentity(row: HabitStorageRow): string | undefined {
	const identity = parseData(row).approved_identity;
	if (!identity || typeof identity !== "object") return undefined;
	if (!("candidate_id" in identity) || identity.candidate_id !== row.id) return undefined;
	if (!("condition" in identity) || typeof identity.condition !== "string" || identity.condition !== normalizeSemanticText(row.condition)) return undefined;
	if (!("behavior" in identity) || typeof identity.behavior !== "string" || identity.behavior !== normalizeSemanticText(row.behavior)) return undefined;
	if (!("polarity" in identity) || Number(identity.polarity) !== Number(row.polarity)) return undefined;
	return JSON.stringify({ candidate_id: row.id, condition: identity.condition, behavior: identity.behavior, polarity: Number(identity.polarity) });
}

function lawHash(row: HabitStorageRow): string | undefined {
	const value = parseData(row).law_hash;
	return typeof value === "string" ? value : undefined;
}

function readValidActiveRows(db: DatabaseSync, userId: string): Array<{ row: HabitStorageRow; candidate: SelectorCandidate; approvalIdentity: string }> {
	const values = db.prepare("SELECT * FROM habits WHERE user_id = ? AND status = 'active' ORDER BY id").all(userId);
	const valid: Array<{ row: HabitStorageRow; candidate: SelectorCandidate; approvalIdentity: string }> = [];
	for (const value of values) {
		if (!isHabitStorageRow(value)) continue;
		try {
			assertValidHabitStorageRow(value);
			const identity = approvedIdentity(value);
			if (!identity) continue;
			valid.push({ row: value, candidate: selectorCandidateFromRow(value), approvalIdentity: identity });
		} catch {
			// One corrupt habit is ineligible; it must not suppress other approved habits.
		}
	}
	return valid;
}

function eligibleCurrentLawRows(db: DatabaseSync, input: { userId: string; law: LawSnapshot; config: AgentExperienceConfig }) {
	const law = revalidateLawSnapshotSync(input.law);
	const rows = readValidActiveRows(db, input.userId).filter((item) => lawHash(item.row) === law.hash);
	const byId = new Map(rows.map((item) => [item.row.id, item]));
	return filterEligibleSelectorCandidates(rows.map((item) => item.candidate), {
		minConfidenceBp: input.config.selector_min_confidence_bp,
		stalenessMax: input.config.selector_staleness_max,
	}).map((candidate) => byId.get(candidate.id)!).filter(Boolean);
}

function semanticRow(row: HabitStorageRow): SemanticHabitRow {
	return { id: row.id, user_id: row.user_id, status: row.status, condition: row.condition, behavior: row.behavior, polarity: row.polarity, checksum: row.checksum, created_at: row.created_at, updated_at: row.updated_at, data_json: row.data_json };
}

function retrievalCandidate(item: { row: HabitStorageRow; candidate: SelectorCandidate; approvalIdentity: string }, delta: AdvisorPrimaryDelta, similarityBp: number): AdvisorHabitRetrievalCandidate {
	return {
		alias: "",
		habitId: item.row.id,
		condition: item.candidate.condition,
		behavior: item.candidate.behavior,
		checksum: item.candidate.checksum,
		lawHash: item.candidate.law_hash ?? "",
		confidenceBp: item.candidate.confidence_bp,
		staleness: item.candidate.staleness,
		approvalIdentity: item.approvalIdentity,
		responseGeneration: delta.generation,
		cursor: delta.cursor,
		advisorEpoch: delta.epoch,
		similarityBp,
	};
}

function assertAdvisorEnabled(config: AgentExperienceConfig): void {
	if (!config.enabled || !config.advisor_enabled || !config.selector_enabled || !config.embedding_enabled) throw new Error("advisor_habit_vectors_disabled");
}

export async function prepareAdvisorHabitVectors(db: DatabaseSync, input: {
	userId: string;
	law: LawSnapshot;
	config: AgentExperienceConfig;
	embeddingAdapter: EmbeddingAdapter;
	now: string;
	signal?: AbortSignal;
}): Promise<{ total: number; cached: number; prepared: number }> {
	const userId = normalizeUserId(input.userId);
	assertAdvisorEnabled(input.config);
	const law = revalidateLawSnapshotSync(input.law);
	const selected = eligibleCurrentLawRows(db, { userId, law, config: input.config }).slice(0, MAX_SELECTOR_ELIGIBLE_HABITS);
	if (!selected.length) return { total: 0, cached: 0, prepared: 0 };
	const policy = semanticPolicyFromConfig(input.config);
	const prepared = await prepareHabitFieldEmbeddings(db, {
		userId,
		habits: selected.map((item) => semanticRow(item.row)),
		policy,
		provider: input.embeddingAdapter,
		signal: input.signal,
	});
	const cached = [...prepared.values()].filter((item) => item.condition.cached && item.behavior.cached).length;
	db.exec("BEGIN IMMEDIATE");
	try {
		if (input.signal?.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new Error("advisor_cancelled");
		if (revalidateLawSnapshotSync(input.law).hash !== law.hash) throw new Error("advisor_habit_snapshot_changed");
		const fresh = new Map(readValidActiveRows(db, userId).map((item) => [item.row.id, item]));
		for (const original of selected) {
			const current = fresh.get(original.row.id);
			if (!current || current.row.checksum !== original.row.checksum || lawHash(current.row) !== law.hash || current.approvalIdentity !== original.approvalIdentity) throw new Error("advisor_habit_snapshot_changed");
			if (current.candidate.confidence_bp < input.config.selector_min_confidence_bp || current.candidate.staleness > input.config.selector_staleness_max) throw new Error("advisor_habit_snapshot_changed");
			const fields = prepared.get(original.row.id);
			if (!fields || fields.habit.checksum !== original.row.checksum) throw new Error("advisor_habit_snapshot_changed");
			for (const field of [fields.condition, fields.behavior]) {
				if (field.cached) continue;
				upsertCachedHabitEmbedding(db, { userId, habitId: original.row.id, embeddingInputVersion: field.embeddingInputVersion, embeddingInputChecksum: field.embeddingInputChecksum, habitRowChecksum: original.row.checksum, provider: policy.provider, model: policy.model, dimensions: policy.dimensions, vector: field.vector, now: input.now });
			}
		}
		db.exec("COMMIT");
	} catch (error) {
		try { db.exec("ROLLBACK"); } catch {}
		throw error;
	}
	return { total: selected.length, cached, prepared: selected.length - cached };
}

export function buildAdvisorHabitAliases(candidates: AdvisorHabitRetrievalCandidate[]): {
	candidates: AdvisorHabitRetrievalCandidate[];
	originalIdByAlias: Map<string, string>;
} {
	if (candidates.length > MAX_ADVISOR_HABIT_CANDIDATES) throw new Error("advisor_habit_candidates_overflow");
	const seen = new Set<string>();
	const originalIdByAlias = new Map<string, string>();
	const aliased = candidates.map((candidate, index) => {
		if (!candidate.habitId || seen.has(candidate.habitId)) throw new Error("advisor_habit_candidate_invalid");
		seen.add(candidate.habitId);
		const alias = `h${index + 1}`;
		originalIdByAlias.set(alias, candidate.habitId);
		return { ...candidate, alias };
	});
	return { candidates: aliased, originalIdByAlias };
}

export async function retrieveAdvisorHabitCandidates(db: DatabaseSync, input: {
	userId: string;
	delta: AdvisorPrimaryDelta;
	activeRequestHabitIds: string[];
	law: LawSnapshot;
	config: AgentExperienceConfig;
	embeddingAdapter: EmbeddingAdapter;
	tokenizerAssetDir: string;
	signal?: AbortSignal;
}): Promise<AdvisorHabitRetrievalCandidate[]> {
	assertAdvisorEnabled(input.config);
	const userId = normalizeUserId(input.userId);
	const law = revalidateLawSnapshotSync(input.law);
	const allEligible = eligibleCurrentLawRows(db, { userId, law, config: input.config });
	const eligible = allEligible.slice(0, MAX_SELECTOR_ELIGIBLE_HABITS);
	const byId = new Map(allEligible.map((item) => [item.row.id, item]));
	const active: AdvisorHabitRetrievalCandidate[] = [];
	for (const id of new Set(input.activeRequestHabitIds)) {
		const item = byId.get(id);
		if (!item) continue;
		active.push(retrievalCandidate(item, input.delta, 10_000));
		if (active.length >= MAX_ACTIVE_REQUEST_HABIT_IDS) break;
	}
	try {
		await prepareAdvisorHabitVectors(db, { userId, law, config: input.config, embeddingAdapter: input.embeddingAdapter, now: new Date().toISOString(), signal: input.signal });
		const query = await prepareAdvisorRetrievalQuery({ delta: input.delta, tokenizerAssetDir: input.tokenizerAssetDir });
		const queryVectors = await input.embeddingAdapter.embed([query.text], { signal: input.signal });
		if (queryVectors.length !== 1 || queryVectors[0].length !== input.embeddingAdapter.dimensions) throw new Error("advisor_query_embedding_invalid");
		const vectors = getCachedHabitFieldEmbeddingsBatch(db, {
			userId,
			provider: input.embeddingAdapter.provider,
			model: input.embeddingAdapter.model,
			dimensions: input.embeddingAdapter.dimensions,
			expectations: eligible.map((item) => ({ habitId: item.row.id, habitRowChecksum: item.row.checksum, condition: item.row.condition, behavior: item.row.behavior })),
		});
		if (vectors.missingIds.length || vectors.invalidIds.length || vectors.embeddings.size !== eligible.length) throw new Error("advisor_habit_vectors_unavailable");
		const ranked = eligible.map((item) => {
			const fields = vectors.embeddings.get(item.row.id);
			if (!fields) throw new Error("advisor_habit_vectors_unavailable");
			return retrievalCandidate(item, input.delta, maxHabitFieldSimilarityBp(normalizedVector(queryVectors[0]), fields.condition.vector, fields.behavior.vector));
		}).filter((candidate) => candidate.similarityBp >= SELECTOR_VECTOR_RETRIEVAL_FLOOR_BP)
			.sort((left, right) => right.similarityBp - left.similarityBp || left.habitId.localeCompare(right.habitId));
		const seen = new Set(active.map((candidate) => candidate.habitId));
		for (const candidate of ranked) {
			if (seen.has(candidate.habitId)) continue;
			seen.add(candidate.habitId);
			active.push(candidate);
			if (active.length >= MAX_ADVISOR_HABIT_CANDIDATES) break;
		}
	} catch {
		// Active-request habits remain useful when optional vector expansion fails.
	}
	return buildAdvisorHabitAliases(active.slice(0, MAX_ADVISOR_HABIT_CANDIDATES)).candidates;
}

export function revalidateAdvisorHabitFinding(db: DatabaseSync, input: {
	userId: string;
	alias: string;
	candidates: AdvisorHabitRetrievalCandidate[];
	originalIdByAlias: ReadonlyMap<string, string>;
	law: LawSnapshot;
	config: AgentExperienceConfig;
	responseGeneration: number;
	cursor: number;
	advisorEpoch: number;
}): AdvisorHabitCandidate {
	const fail = (): never => { throw new Error("advisor_habit_snapshot_changed"); };
	const userId = normalizeUserId(input.userId);
	try { assertAdvisorEnabled(input.config); } catch { return fail(); }
	let law: LawSnapshot;
	try { law = revalidateLawSnapshotSync(input.law); } catch { return fail(); }
	const habitId = input.originalIdByAlias.get(input.alias);
	const expected = input.candidates.find((candidate) => candidate.alias === input.alias);
	if (!habitId || !expected || expected.habitId !== habitId || expected.responseGeneration !== input.responseGeneration || expected.cursor !== input.cursor || expected.advisorEpoch !== input.advisorEpoch) return fail();
	const value = db.prepare("SELECT * FROM habits WHERE user_id = ? AND id = ?").get(userId, habitId);
	if (!isHabitStorageRow(value)) return fail();
	try { assertValidHabitStorageRow(value); } catch { return fail(); }
	const identity = approvedIdentity(value);
	const candidate = selectorCandidateFromRow(value);
	if (value.user_id !== userId || value.status !== "active" || value.checksum !== expected.checksum || value.condition !== expected.condition || value.behavior !== expected.behavior) return fail();
	if (lawHash(value) !== law.hash || expected.lawHash !== law.hash || identity !== expected.approvalIdentity) return fail();
	if (candidate.confidence_bp < input.config.selector_min_confidence_bp || candidate.staleness > input.config.selector_staleness_max || candidate.confidence_bp !== expected.confidenceBp || candidate.staleness !== expected.staleness) return fail();
	return { alias: expected.alias, habitId, condition: value.condition ?? "", behavior: value.behavior ?? "", checksum: value.checksum, lawHash: law.hash };
}
