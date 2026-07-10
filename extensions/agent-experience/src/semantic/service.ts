import {
	chooseCanonicalHabit,
	classifySimilarityBp,
	cosineBp,
	effectiveFieldSimilarityBp,
	embeddingInputChecksum,
	habitFieldEmbeddingInputsV1,
	normalizedVector,
	SEMANTIC_BEHAVIOR_EMBEDDING_INPUT_VERSION,
	SEMANTIC_CONDITION_EMBEDDING_INPUT_VERSION,
	SEMANTIC_DUPLICATE_METHOD_VERSION,
} from "./core.ts";
import {
	duplicateMethod,
	duplicateWordingHashesMatch,
	getCachedHabitEmbedding,
	getKeptSeparateDuplicate,
	getSemanticHabitRow,
	insertHabitDuplicateAudit,
	listHabitDuplicates,
	markCandidateDuplicateResolution,
	restoreCandidateDuplicateResolution,
	selectSemanticHabitRows,
	updateHabitDuplicateDecision,
	upsertCachedHabitEmbedding,
	upsertHabitDuplicate,
} from "./storage.ts";
import {
	LOCAL_EMBEDDING_DIMENSIONS,
	LOCAL_EMBEDDING_MAX_BATCH,
	LOCAL_EMBEDDING_MODEL,
	LOCAL_EMBEDDING_PROVIDER,
	LOCAL_EMBEDDING_REVIEW_THRESHOLD_BP,
	LOCAL_EMBEDDING_STRONG_THRESHOLD_BP,
	LOCAL_EMBEDDING_TIMEOUT_MS,
} from "./local-model-manifest.ts";
import type { CachedHabitEmbedding, EmbeddingAdapter, SemanticDedupePolicy, SemanticDuplicateMatch, SemanticGateDecision, SemanticHabitRow } from "./types.ts";

export const SEMANTIC_COMPARISON_STATUSES = ["active", "disabled"];
export const SEMANTIC_STATE_STATUSES = ["active", "disabled", "candidate"];
export const MAX_SEMANTIC_SCAN_HABITS = 100;
export const MAX_SEMANTIC_SCAN_PAIRS = 4_950;
const MAX_ACTIVATION_REPREPARES = 2;

interface PreparedFieldEmbedding {
	embeddingInputVersion: string;
	embeddingInputChecksum: string;
	vector: Float32Array;
	cached: boolean;
}

interface PreparedEmbedding {
	habit: SemanticHabitRow;
	condition: PreparedFieldEmbedding;
	behavior: PreparedFieldEmbedding;
}

interface PairScore {
	similarityBp: number;
	conditionSimilarityBp: number;
	behaviorSimilarityBp: number;
	strength: "none" | "review" | "strong";
}

export interface SemanticProgress {
	phase: "snapshot" | "embedding" | "comparing" | "saving" | "done";
	completed: number;
	total: number;
}

class SemanticSnapshotChanged extends Error {}

export function sanitizePolicy(policy: Partial<SemanticDedupePolicy> | undefined): SemanticDedupePolicy {
	const rawReview = policy?.reviewThresholdBp === undefined ? LOCAL_EMBEDDING_REVIEW_THRESHOLD_BP : Math.trunc(Number(policy.reviewThresholdBp));
	const reviewThresholdBp = Number.isFinite(rawReview) ? Math.max(0, Math.min(10000, rawReview)) : LOCAL_EMBEDDING_REVIEW_THRESHOLD_BP;
	const rawStrong = policy?.strongThresholdBp === undefined ? LOCAL_EMBEDDING_STRONG_THRESHOLD_BP : Math.trunc(Number(policy.strongThresholdBp));
	const requestedStrongThresholdBp = Number.isFinite(rawStrong) ? Math.max(0, Math.min(10000, rawStrong)) : LOCAL_EMBEDDING_STRONG_THRESHOLD_BP;
	return {
		enabled: policy?.enabled === true,
		provider: String(policy?.provider || LOCAL_EMBEDDING_PROVIDER),
		model: String(policy?.model || LOCAL_EMBEDDING_MODEL),
		dimensions: Math.max(1, Math.min(8192, Math.trunc(Number(policy?.dimensions ?? LOCAL_EMBEDDING_DIMENSIONS)))) || LOCAL_EMBEDDING_DIMENSIONS,
		reviewThresholdBp,
		strongThresholdBp: Math.max(reviewThresholdBp, requestedStrongThresholdBp),
		timeoutMs: Math.max(1, Math.min(300000, Math.trunc(Number(policy?.timeoutMs ?? LOCAL_EMBEDDING_TIMEOUT_MS)))) || LOCAL_EMBEDDING_TIMEOUT_MS,
	};
}

function policySummary(policy: SemanticDedupePolicy) {
	return {
		enabled: policy.enabled,
		provider: policy.provider,
		model: policy.model,
		dimensions: policy.dimensions,
		reviewThresholdBp: policy.reviewThresholdBp,
		strongThresholdBp: policy.strongThresholdBp,
		scoringMethod: SEMANTIC_DUPLICATE_METHOD_VERSION,
		conditionInputVersion: SEMANTIC_CONDITION_EMBEDDING_INPUT_VERSION,
		behaviorInputVersion: SEMANTIC_BEHAVIOR_EMBEDDING_INPUT_VERSION,
	};
}

function assertProviderMatches(policy: SemanticDedupePolicy, provider: EmbeddingAdapter): void {
	if (provider.provider !== policy.provider || provider.model !== policy.model || provider.dimensions !== policy.dimensions) throw new Error("Semantic embedding runtime does not match the fixed local policy");
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("semantic_operation_cancelled");
}

function rowSnapshot(rows: SemanticHabitRow[]): string {
	return JSON.stringify(rows.map((row) => [row.id, row.status, row.checksum, row.polarity]));
}

function relationSnapshot(db: any, userId: string): string {
	const rows = db.prepare("SELECT id, pair_key, method, decision, checksum FROM habit_duplicates WHERE user_id = ? ORDER BY method, pair_key, id").all(userId);
	return JSON.stringify(rows.map((row: any) => [row.id, row.pair_key, row.method, row.decision, row.checksum]));
}

function comparisonRows(db: any, input: { userId: string; target: SemanticHabitRow; policy: SemanticDedupePolicy; statuses?: string[] }): SemanticHabitRow[] {
	return selectSemanticHabitRows(db, { userId: input.userId, statuses: input.statuses || SEMANTIC_COMPARISON_STATUSES })
		.filter((row) => row.id !== input.target.id)
		.filter((row) => row.status !== "archived" && row.status !== "suppressed_by_law")
		.filter((row) => row.polarity === input.target.polarity)
		.filter((row) => !(row.status === "candidate" && input.target.status === "candidate"))
		.filter((row) => !getKeptSeparateDuplicate(db, { userId: input.userId, habitId: input.target.id, otherHabitId: row.id, provider: input.policy.provider, model: input.policy.model, dimensions: input.policy.dimensions }));
}

async function prepareHabitEmbeddings(db: any, input: { userId: string; habits: SemanticHabitRow[]; policy: SemanticDedupePolicy; provider: EmbeddingAdapter; signal?: AbortSignal; batchSize?: number; onProgress?: (progress: SemanticProgress) => void }): Promise<Map<string, PreparedEmbedding>> {
	const policy = sanitizePolicy(input.policy);
	assertProviderMatches(policy, input.provider);
	const partial = new Map<string, { habit: SemanticHabitRow; condition?: PreparedFieldEmbedding; behavior?: PreparedFieldEmbedding }>();
	const missing: Array<{ habit: SemanticHabitRow; field: "condition" | "behavior"; text: string; version: string; checksum: string }> = [];
	for (const habit of input.habits) {
		const fields = habitFieldEmbeddingInputsV1({ condition: habit.condition, behavior: habit.behavior });
		const entry: { habit: SemanticHabitRow; condition?: PreparedFieldEmbedding; behavior?: PreparedFieldEmbedding } = { habit };
		for (const field of ["condition", "behavior"] as const) {
			const version = field === "condition" ? SEMANTIC_CONDITION_EMBEDDING_INPUT_VERSION : SEMANTIC_BEHAVIOR_EMBEDDING_INPUT_VERSION;
			const text = fields[field];
			const checksum = embeddingInputChecksum(text, version);
			const cached = getCachedHabitEmbedding(db, { userId: input.userId, habitId: habit.id, embeddingInputVersion: version, embeddingInputChecksum: checksum, habitRowChecksum: habit.checksum, provider: policy.provider, model: policy.model, dimensions: policy.dimensions });
			if (cached) entry[field] = { embeddingInputVersion: version, embeddingInputChecksum: checksum, vector: cached.vector, cached: true };
			else missing.push({ habit, field, text, version, checksum });
		}
		partial.set(habit.id, entry);
	}
	const total = input.habits.length * 2;
	const batchSize = Math.max(1, Math.min(LOCAL_EMBEDDING_MAX_BATCH, Math.trunc(input.batchSize || 32)));
	let completed = total - missing.length;
	input.onProgress?.({ phase: "embedding", completed, total });
	for (let offset = 0; offset < missing.length; offset += batchSize) {
		throwIfAborted(input.signal);
		const batch = missing.slice(offset, offset + batchSize);
		const vectors = await input.provider.embed(batch.map((item) => item.text), { signal: input.signal });
		if (!Array.isArray(vectors) || vectors.length !== batch.length) throw new Error("Local embedding runtime returned wrong vector count");
		for (let index = 0; index < batch.length; index += 1) {
			const vector = vectors[index];
			if (!vector || vector.length !== policy.dimensions) throw new Error("Local embedding runtime returned wrong dimensions");
			const item = batch[index];
			const entry = partial.get(item.habit.id);
			if (!entry) throw new Error("Prepared habit entry missing");
			entry[item.field] = { embeddingInputVersion: item.version, embeddingInputChecksum: item.checksum, vector: normalizedVector(vector), cached: false };
		}
		completed += batch.length;
		input.onProgress?.({ phase: "embedding", completed, total });
	}
	throwIfAborted(input.signal);
	const prepared = new Map<string, PreparedEmbedding>();
	for (const [habitId, entry] of partial) {
		if (!entry.condition || !entry.behavior) throw new Error("Prepared field embedding missing");
		prepared.set(habitId, { habit: entry.habit, condition: entry.condition, behavior: entry.behavior });
	}
	return prepared;
}

function persistPreparedEmbedding(db: any, input: { userId: string; prepared: PreparedEmbedding; policy: SemanticDedupePolicy; now: string }): { condition: CachedHabitEmbedding; behavior: CachedHabitEmbedding } {
	const save = (field: PreparedFieldEmbedding) => upsertCachedHabitEmbedding(db, {
		userId: input.userId,
		habitId: input.prepared.habit.id,
		embeddingInputVersion: field.embeddingInputVersion,
		embeddingInputChecksum: field.embeddingInputChecksum,
		habitRowChecksum: input.prepared.habit.checksum,
		provider: input.policy.provider,
		model: input.policy.model,
		dimensions: input.policy.dimensions,
		vector: field.vector,
		now: input.now,
	});
	return { condition: save(input.prepared.condition), behavior: save(input.prepared.behavior) };
}

function scorePair(left: PreparedEmbedding, right: PreparedEmbedding, policy: SemanticDedupePolicy): PairScore {
	const conditionSimilarityBp = cosineBp(left.condition.vector, right.condition.vector);
	const behaviorSimilarityBp = cosineBp(left.behavior.vector, right.behavior.vector);
	const similarityBp = effectiveFieldSimilarityBp(conditionSimilarityBp, behaviorSimilarityBp);
	return { similarityBp, conditionSimilarityBp, behaviorSimilarityBp, strength: classifySimilarityBp(similarityBp, policy) };
}

function computeMatches(input: { target: SemanticHabitRow; comparators: SemanticHabitRow[]; prepared: Map<string, PreparedEmbedding>; policy: SemanticDedupePolicy }): SemanticDuplicateMatch[] {
	const target = input.prepared.get(input.target.id);
	if (!target) throw new Error("Prepared target embedding missing");
	const matches: SemanticDuplicateMatch[] = [];
	for (const row of input.comparators) {
		const other = input.prepared.get(row.id);
		if (!other) throw new Error("Prepared comparator embedding missing");
		const score = scorePair(target, other, input.policy);
		if (score.strength !== "none") matches.push({ habit: row, similarityBp: score.similarityBp, conditionSimilarityBp: score.conditionSimilarityBp, behaviorSimilarityBp: score.behaviorSimilarityBp, strength: score.strength });
	}
	return matches.sort((left, right) => (right.similarityBp - left.similarityBp) || left.habit.id.localeCompare(right.habit.id));
}

function matchData(match: Pick<SemanticDuplicateMatch, "similarityBp" | "conditionSimilarityBp" | "behaviorSimilarityBp" | "strength">) {
	return { similarity_bp: match.similarityBp, condition_similarity_bp: match.conditionSimilarityBp, behavior_similarity_bp: match.behaviorSimilarityBp, strength: match.strength, scoring_method: SEMANTIC_DUPLICATE_METHOD_VERSION };
}

function writeActivationBlocks(db: any, input: { userId: string; target: SemanticHabitRow; matches: SemanticDuplicateMatch[]; policy: SemanticDedupePolicy; targetKind: string; now: string }): void {
	for (const match of input.matches) {
		const canonical = chooseCanonicalHabit(input.target, match.habit);
		const duplicate = canonical.id === input.target.id ? match.habit : input.target;
		const relation = upsertHabitDuplicate(db, { userId: input.userId, habitId: input.target.id, otherHabitId: match.habit.id, canonicalHabitId: canonical.id, duplicateHabitId: duplicate.id, similarityBp: match.similarityBp, thresholdBp: input.policy.reviewThresholdBp, provider: input.policy.provider, model: input.policy.model, dimensions: input.policy.dimensions, decision: "pending", data: { action: "activation_block", target_kind: input.targetKind, ...matchData(match), policy: policySummary(input.policy) }, now: input.now });
		if (input.target.status === "candidate") markCandidateDuplicateResolution(db, { userId: input.userId, habitId: input.target.id, relationId: relation.id, data: { action: "activation_block", matched_habit_id: match.habit.id, canonical_habit_id: canonical.id, ...matchData(match) }, now: input.now });
		insertHabitDuplicateAudit(db, { userId: input.userId, duplicateId: relation.id, targetKind: input.targetKind, targetId: input.target.id, action: "semantic_activation_block", before: null, after: relation, data: { matched_habit_id: match.habit.id, ...matchData(match), policy: policySummary(input.policy) }, now: input.now });
	}
}

function unavailableDecision(policy: SemanticDedupePolicy, error?: unknown): SemanticGateDecision {
	const detail = error === undefined ? undefined : String((error as any)?.message || error).slice(0, 300);
	return { pass: false, reason: "semantic_unavailable", matches: [], policy: policySummary(policy), ...(detail ? { error: detail } : {}) } as SemanticGateDecision;
}

function auditUnavailable<T>(db: any, input: { userId: string; targetHabitId: string; expectedStatus: string; expectedChecksum: string; targetKind: string; policy: SemanticDedupePolicy; now: string; reason: string; onBlocked?: (target: SemanticHabitRow, semantic: SemanticGateDecision) => T }): { semantic: SemanticGateDecision; result?: T; target: SemanticHabitRow } {
	db.exec("BEGIN IMMEDIATE");
	try {
		const target = getSemanticHabitRow(db, { userId: input.userId, habitId: input.targetHabitId });
		if (!target || target.status !== input.expectedStatus || target.checksum !== input.expectedChecksum) throw new Error("Stale habit state");
		const semantic = unavailableDecision(input.policy, input.reason);
		insertHabitDuplicateAudit(db, { userId: input.userId, targetKind: input.targetKind, targetId: input.targetHabitId, action: "semantic_gate_unavailable", data: { policy: policySummary(input.policy), reason: input.reason.slice(0, 300) }, now: input.now });
		const result = input.onBlocked?.(target, semantic);
		db.exec("COMMIT");
		return { semantic, result, target: getSemanticHabitRow(db, { userId: input.userId, habitId: input.targetHabitId })! };
	} catch (error) {
		try { db.exec("ROLLBACK"); } catch {}
		throw error;
	}
}

export async function runAtomicSemanticActivation<T>(db: any, input: { userId: string; targetHabitId: string; expectedStatus: string; expectedChecksum: string; policy?: Partial<SemanticDedupePolicy>; provider?: EmbeddingAdapter; now: string; signal?: AbortSignal; targetKind: string; transition: (target: SemanticHabitRow, semantic: SemanticGateDecision) => T; onBlocked?: (target: SemanticHabitRow, semantic: SemanticGateDecision) => T }): Promise<{ semantic: SemanticGateDecision; transitioned: boolean; result?: T; target: SemanticHabitRow }> {
	const policy = sanitizePolicy(input.policy);
	if (!policy.enabled) {
		const semantic: SemanticGateDecision = { pass: true, reason: "disabled", matches: [], policy: policySummary(policy) };
		db.exec("BEGIN IMMEDIATE");
		try {
			const target = getSemanticHabitRow(db, { userId: input.userId, habitId: input.targetHabitId });
			if (!target || target.status !== input.expectedStatus || target.checksum !== input.expectedChecksum) throw new Error("Stale habit state");
			const result = input.transition(target, semantic);
			db.exec("COMMIT");
			return { semantic, transitioned: true, result, target };
		} catch (error) {
			try { db.exec("ROLLBACK"); } catch {}
			throw error;
		}
	}
	if (!input.provider) {
		const blocked = auditUnavailable(db, { ...input, policy, reason: "local_embedding_runtime_missing" });
		return { ...blocked, transitioned: false };
	}
	for (let attempt = 0; attempt < MAX_ACTIVATION_REPREPARES; attempt += 1) {
		throwIfAborted(input.signal);
		const target = getSemanticHabitRow(db, { userId: input.userId, habitId: input.targetHabitId });
		if (!target || target.status !== input.expectedStatus || target.checksum !== input.expectedChecksum) throw new Error("Stale habit state");
		const comparators = comparisonRows(db, { userId: input.userId, target, policy });
		let prepared: Map<string, PreparedEmbedding>;
		try {
			prepared = await prepareHabitEmbeddings(db, { userId: input.userId, habits: [target, ...comparators], policy, provider: input.provider, signal: input.signal, batchSize: LOCAL_EMBEDDING_MAX_BATCH });
		} catch (error: any) {
			const blocked = auditUnavailable(db, { ...input, policy, reason: String(error?.message || error) });
			return { ...blocked, transitioned: false };
		}
		try {
			db.exec("BEGIN IMMEDIATE");
			const freshTarget = getSemanticHabitRow(db, { userId: input.userId, habitId: input.targetHabitId });
			if (!freshTarget || freshTarget.status !== input.expectedStatus || freshTarget.checksum !== input.expectedChecksum) throw new Error("Stale habit state");
			const freshComparators = comparisonRows(db, { userId: input.userId, target: freshTarget, policy });
			if (rowSnapshot(freshComparators) !== rowSnapshot(comparators)) throw new SemanticSnapshotChanged("Semantic comparator snapshot changed");
			for (const item of prepared.values()) persistPreparedEmbedding(db, { userId: input.userId, prepared: item, policy, now: input.now });
			const matches = computeMatches({ target: freshTarget, comparators: freshComparators, prepared, policy });
			const semantic: SemanticGateDecision = matches.length
				? { pass: false, reason: "semantic_duplicate", matches, policy: policySummary(policy) }
				: { pass: true, reason: "pass", matches: [], policy: policySummary(policy) };
			if (matches.length) {
				writeActivationBlocks(db, { userId: input.userId, target: freshTarget, matches, policy, targetKind: input.targetKind, now: input.now });
				const blockedTarget = getSemanticHabitRow(db, { userId: input.userId, habitId: input.targetHabitId })!;
				const result = input.onBlocked?.(blockedTarget, semantic);
				db.exec("COMMIT");
				return { semantic, transitioned: false, result, target: getSemanticHabitRow(db, { userId: input.userId, habitId: input.targetHabitId })! };
			}
			const result = input.transition(freshTarget, semantic);
			db.exec("COMMIT");
			return { semantic, transitioned: true, result, target: freshTarget };
		} catch (error) {
			try { db.exec("ROLLBACK"); } catch {}
			if (error instanceof SemanticSnapshotChanged && attempt + 1 < MAX_ACTIVATION_REPREPARES) continue;
			throw error;
		}
	}
	throw new Error("Semantic state changed repeatedly; retry the action");
}

export async function findSemanticDuplicateMatches(db: any, input: { userId: string; target: SemanticHabitRow; policy: SemanticDedupePolicy; provider: EmbeddingAdapter; now: string; statuses?: string[]; signal?: AbortSignal }): Promise<SemanticDuplicateMatch[]> {
	const policy = sanitizePolicy(input.policy);
	if (!policy.enabled) return [];
	const comparators = comparisonRows(db, { userId: input.userId, target: input.target, policy, statuses: input.statuses || SEMANTIC_COMPARISON_STATUSES });
	const prepared = await prepareHabitEmbeddings(db, { userId: input.userId, habits: [input.target, ...comparators], policy, provider: input.provider, signal: input.signal, batchSize: LOCAL_EMBEDDING_MAX_BATCH });
	for (const item of prepared.values()) persistPreparedEmbedding(db, { userId: input.userId, prepared: item, policy, now: input.now });
	return computeMatches({ target: input.target, comparators, prepared, policy });
}

export async function checkSemanticActivationGate(db: any, input: { userId: string; targetHabitId: string; policy?: Partial<SemanticDedupePolicy>; provider?: EmbeddingAdapter; now: string; signal?: AbortSignal; targetKind?: string }): Promise<SemanticGateDecision> {
	const target = getSemanticHabitRow(db, { userId: input.userId, habitId: input.targetHabitId });
	if (!target) throw new Error("Habit not found");
	const result = await runAtomicSemanticActivation(db, { ...input, expectedStatus: target.status, expectedChecksum: target.checksum, targetKind: input.targetKind || "habit", transition: () => undefined });
	return result.semantic;
}

function relationDismissReason(db: any, input: { userId: string; relation: any; method: string; policy: SemanticDedupePolicy }): string | undefined {
	const row = input.relation;
	if (row.method !== input.method) return "obsolete_scoring_method";
	const left = getSemanticHabitRow(db, { userId: input.userId, habitId: row.habit_a });
	const right = getSemanticHabitRow(db, { userId: input.userId, habitId: row.habit_b });
	if (!left || !right) return "missing_habit";
	const allowed = new Set(SEMANTIC_STATE_STATUSES);
	if (!allowed.has(left.status) || !allowed.has(right.status)) return "ineligible_habit_status";
	if (left.status === "candidate" && right.status === "candidate") return "candidate_pair_not_supported";
	if (left.polarity !== right.polarity) return "polarity_changed";
	if (!duplicateWordingHashesMatch(db, { userId: input.userId, relation: row })) return "habit_wording_changed";
	if (Number(row.similarity_bp) < input.policy.reviewThresholdBp) return "below_current_review_threshold";
	return undefined;
}

export function reconcileSemanticDuplicateThresholds(db: any, input: { userId: string; policy?: Partial<SemanticDedupePolicy>; now: string }) {
	const policy = sanitizePolicy(input.policy);
	if (!policy.enabled) return { user_id: input.userId, checked: 0, dismissed: [], refreshed: [], enabled: false };
	const method = duplicateMethod({ provider: policy.provider, model: policy.model, dimensions: policy.dimensions });
	const pending = listHabitDuplicates(db, { userId: input.userId, decision: "pending" });
	const dismissed: string[] = [];
	const refreshed: string[] = [];
	for (const row of pending) {
		const similarityBp = Number(row.similarity_bp);
		const previousThresholdBp = Number(row.threshold_bp);
		let existingData: any = {};
		try { existingData = JSON.parse(row.data_json || "{}"); } catch {}
		const reason = relationDismissReason(db, { userId: input.userId, relation: row, method, policy });
		if (reason) {
			const data = { ...existingData, resolution: { action: "dismissed_semantic_policy_change", reason, resolved_at: input.now, previous_threshold_bp: previousThresholdBp, current_threshold_bp: policy.reviewThresholdBp, previous_method: row.method, current_method: method } };
			const changed = updateHabitDuplicateDecision(db, { userId: input.userId, duplicateId: row.id, decision: "dismissed_threshold_change", data, thresholdBp: policy.reviewThresholdBp, now: input.now });
			insertHabitDuplicateAudit(db, { userId: input.userId, duplicateId: row.id, targetKind: "habit_duplicate", targetId: row.id, action: "dismiss_semantic_policy_change", before: changed.before, after: changed.after, data: { reason, previous_threshold_bp: previousThresholdBp, current_threshold_bp: policy.reviewThresholdBp, similarity_bp: similarityBp, previous_method: row.method, current_method: method }, now: input.now });
			restoreCandidateDuplicateResolution(db, { userId: input.userId, habitId: row.habit_a, relationId: row.id, reviewStatus: "candidate", data: { reason }, now: input.now });
			restoreCandidateDuplicateResolution(db, { userId: input.userId, habitId: row.habit_b, relationId: row.id, reviewStatus: "candidate", data: { reason }, now: input.now });
			dismissed.push(row.id);
		} else if (previousThresholdBp !== policy.reviewThresholdBp) {
			const data = { ...existingData, threshold_refresh: { refreshed_at: input.now, previous_threshold_bp: previousThresholdBp, current_threshold_bp: policy.reviewThresholdBp } };
			const changed = updateHabitDuplicateDecision(db, { userId: input.userId, duplicateId: row.id, decision: "pending", data, thresholdBp: policy.reviewThresholdBp, now: input.now });
			insertHabitDuplicateAudit(db, { userId: input.userId, duplicateId: row.id, targetKind: "habit_duplicate", targetId: row.id, action: "refresh_threshold_change", before: changed.before, after: changed.after, data: { previous_threshold_bp: previousThresholdBp, current_threshold_bp: policy.reviewThresholdBp, similarity_bp: similarityBp }, now: input.now });
			refreshed.push(row.id);
		}
	}
	return { user_id: input.userId, checked: pending.length, dismissed, refreshed, enabled: true };
}

function scanPairs(db: any, input: { userId: string; rows: SemanticHabitRow[]; policy: SemanticDedupePolicy }): Array<{ left: SemanticHabitRow; right: SemanticHabitRow }> {
	const pairs: Array<{ left: SemanticHabitRow; right: SemanticHabitRow }> = [];
	for (let leftIndex = 0; leftIndex < input.rows.length; leftIndex += 1) {
		for (let rightIndex = leftIndex + 1; rightIndex < input.rows.length; rightIndex += 1) {
			const left = input.rows[leftIndex];
			const right = input.rows[rightIndex];
			if (left.polarity !== right.polarity) continue;
			if (left.status === "candidate" && right.status === "candidate") continue;
			if (getKeptSeparateDuplicate(db, { userId: input.userId, habitId: left.id, otherHabitId: right.id, provider: input.policy.provider, model: input.policy.model, dimensions: input.policy.dimensions })) continue;
			pairs.push({ left, right });
		}
	}
	return pairs;
}

export async function scanAndBackfillSemanticDuplicates(db: any, input: { userId: string; policy?: Partial<SemanticDedupePolicy>; provider?: EmbeddingAdapter; now: string; statuses?: string[]; signal?: AbortSignal; batchSize?: number; onProgress?: (progress: SemanticProgress) => void; beforeCommitForTest?: () => void; failAfterWritesForTest?: boolean }) {
	const policy = sanitizePolicy(input.policy);
	if (!policy.enabled) return { user_id: input.userId, checked: 0, relations: [], threshold_reconciliation: { checked: 0, dismissed: [], refreshed: [] }, enabled: false };
	if (!input.provider) throw new Error("Local embedding runtime unavailable");
	throwIfAborted(input.signal);
	const statuses = input.statuses || SEMANTIC_COMPARISON_STATUSES;
	const stateRows = selectSemanticHabitRows(db, { userId: input.userId, statuses: SEMANTIC_STATE_STATUSES }).filter((row) => row.status !== "archived" && row.status !== "suppressed_by_law");
	if (stateRows.length > MAX_SEMANTIC_SCAN_HABITS) throw new Error(`Duplicate scan is limited to ${MAX_SEMANTIC_SCAN_HABITS} current habits; archive unused habits and retry`);
	const rows = selectSemanticHabitRows(db, { userId: input.userId, statuses }).filter((row) => row.status !== "archived" && row.status !== "suppressed_by_law");
	const pairs = scanPairs(db, { userId: input.userId, rows, policy });
	if (pairs.length > MAX_SEMANTIC_SCAN_PAIRS) throw new Error("Duplicate scan pair limit exceeded");
	const rowState = rowSnapshot(stateRows);
	const relationState = relationSnapshot(db, input.userId);
	input.onProgress?.({ phase: "snapshot", completed: stateRows.length, total: stateRows.length });
	const pairHabits = [...new Map(pairs.flatMap((pair) => [pair.left, pair.right]).map((row) => [row.id, row])).values()];
	const prepared = pairHabits.length
		? await prepareHabitEmbeddings(db, { userId: input.userId, habits: pairHabits, policy, provider: input.provider, signal: input.signal, batchSize: input.batchSize, onProgress: input.onProgress })
		: new Map<string, PreparedEmbedding>();
	if (!pairHabits.length) input.onProgress?.({ phase: "embedding", completed: 0, total: 0 });
	const proposed: Array<{ left: SemanticHabitRow; right: SemanticHabitRow; similarityBp: number; conditionSimilarityBp: number; behaviorSimilarityBp: number; strength: "review" | "strong" }> = [];
	let compared = 0;
	input.onProgress?.({ phase: "comparing", completed: 0, total: pairs.length });
	for (const pair of pairs) {
		throwIfAborted(input.signal);
		const score = scorePair(prepared.get(pair.left.id)!, prepared.get(pair.right.id)!, policy);
		if (score.strength !== "none") proposed.push({ left: pair.left, right: pair.right, similarityBp: score.similarityBp, conditionSimilarityBp: score.conditionSimilarityBp, behaviorSimilarityBp: score.behaviorSimilarityBp, strength: score.strength });
		compared += 1;
		if (compared % 128 === 0) {
			input.onProgress?.({ phase: "comparing", completed: compared, total: pairs.length });
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}
	input.onProgress?.({ phase: "comparing", completed: compared, total: pairs.length });
	throwIfAborted(input.signal);
	input.beforeCommitForTest?.();
	input.onProgress?.({ phase: "saving", completed: 0, total: proposed.length });
	const relations: any[] = [];
	let threshold_reconciliation: any;
	db.exec("BEGIN IMMEDIATE");
	try {
		throwIfAborted(input.signal);
		const freshStateRows = selectSemanticHabitRows(db, { userId: input.userId, statuses: SEMANTIC_STATE_STATUSES }).filter((row) => row.status !== "archived" && row.status !== "suppressed_by_law");
		if (rowSnapshot(freshStateRows) !== rowState || relationSnapshot(db, input.userId) !== relationState) throw new Error("Duplicate scan state changed; retry");
		for (const item of prepared.values()) persistPreparedEmbedding(db, { userId: input.userId, prepared: item, policy, now: input.now });
		threshold_reconciliation = reconcileSemanticDuplicateThresholds(db, { userId: input.userId, policy, now: input.now });
		for (let index = 0; index < proposed.length; index += 1) {
			const item = proposed[index];
			const canonical = chooseCanonicalHabit(item.left, item.right);
			const duplicate = canonical.id === item.left.id ? item.right : item.left;
			const relation = upsertHabitDuplicate(db, { userId: input.userId, habitId: item.left.id, otherHabitId: item.right.id, canonicalHabitId: canonical.id, duplicateHabitId: duplicate.id, similarityBp: item.similarityBp, thresholdBp: policy.reviewThresholdBp, provider: policy.provider, model: policy.model, dimensions: policy.dimensions, decision: "pending", data: { action: "scan_backfill", ...matchData(item), policy: policySummary(policy) }, now: input.now });
			if (item.left.status === "candidate") markCandidateDuplicateResolution(db, { userId: input.userId, habitId: item.left.id, relationId: relation.id, data: { action: "scan_backfill", matched_habit_id: item.right.id, canonical_habit_id: canonical.id, ...matchData(item) }, now: input.now });
			if (item.right.status === "candidate") markCandidateDuplicateResolution(db, { userId: input.userId, habitId: item.right.id, relationId: relation.id, data: { action: "scan_backfill", matched_habit_id: item.left.id, canonical_habit_id: canonical.id, ...matchData(item) }, now: input.now });
			insertHabitDuplicateAudit(db, { userId: input.userId, duplicateId: relation.id, targetKind: "habit_duplicate", targetId: relation.id, action: "semantic_scan_backfill", before: null, after: relation, data: matchData(item), now: input.now });
			relations.push(relation);
			if (input.failAfterWritesForTest && index === 0) throw new Error("injected_semantic_scan_write_failure");
		}
		db.exec("COMMIT");
	} catch (error) {
		try { db.exec("ROLLBACK"); } catch {}
		throw error;
	}
	input.onProgress?.({ phase: "done", completed: relations.length, total: relations.length });
	return { user_id: input.userId, checked: rows.length, relations, threshold_reconciliation, enabled: true };
}
