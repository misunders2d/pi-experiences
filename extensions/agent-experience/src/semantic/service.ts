import { chooseCanonicalHabit, classifySimilarityBp, cosineBp, embeddingInputChecksum, habitEmbeddingInputV1, normalizedVector } from "./core.ts";
import { duplicateMethod, getCachedHabitEmbedding, getKeptSeparateDuplicate, getSemanticHabitRow, insertHabitDuplicateAudit, listHabitDuplicates, markCandidateDuplicateResolution, restoreCandidateDuplicateResolution, selectSemanticHabitRows, updateHabitDuplicateDecision, upsertCachedHabitEmbedding, upsertHabitDuplicate } from "./storage.ts";
import { LOCAL_EMBEDDING_DIMENSIONS, LOCAL_EMBEDDING_MAX_BATCH, LOCAL_EMBEDDING_MODEL, LOCAL_EMBEDDING_PROVIDER, LOCAL_EMBEDDING_REVIEW_THRESHOLD_BP, LOCAL_EMBEDDING_STRONG_THRESHOLD_BP, LOCAL_EMBEDDING_TIMEOUT_MS } from "./local-model-manifest.ts";
import type { CachedHabitEmbedding, EmbeddingAdapter, SemanticDedupePolicy, SemanticDuplicateMatch, SemanticGateDecision, SemanticHabitRow } from "./types.ts";

export const SEMANTIC_COMPARISON_STATUSES = ["active", "disabled", "candidate"];
export const MAX_SEMANTIC_SCAN_HABITS = 100;
export const MAX_SEMANTIC_SCAN_PAIRS = 4_950;
const MAX_ACTIVATION_REPREPARES = 2;

interface PreparedEmbedding {
	habit: SemanticHabitRow;
	embeddingInputChecksum: string;
	vector: Float32Array;
	cached: boolean;
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
	return { enabled: policy.enabled, provider: policy.provider, model: policy.model, dimensions: policy.dimensions, reviewThresholdBp: policy.reviewThresholdBp, strongThresholdBp: policy.strongThresholdBp };
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

function relationSnapshot(db: any, userId: string, method: string): string {
	const rows = db.prepare("SELECT id, pair_key, decision, checksum FROM habit_duplicates WHERE user_id = ? AND method = ? ORDER BY pair_key, id").all(userId, method);
	return JSON.stringify(rows.map((row: any) => [row.id, row.pair_key, row.decision, row.checksum]));
}

function comparisonRows(db: any, input: { userId: string; target: SemanticHabitRow; policy: SemanticDedupePolicy; statuses?: string[] }): SemanticHabitRow[] {
	return selectSemanticHabitRows(db, { userId: input.userId, statuses: input.statuses || ["active", "disabled"] })
		.filter((row) => row.id !== input.target.id)
		.filter((row) => row.status !== "archived" && row.status !== "suppressed_by_law")
		.filter((row) => row.polarity === input.target.polarity)
		.filter((row) => !getKeptSeparateDuplicate(db, { userId: input.userId, habitId: input.target.id, otherHabitId: row.id, provider: input.policy.provider, model: input.policy.model, dimensions: input.policy.dimensions }));
}

async function prepareHabitEmbeddings(db: any, input: { userId: string; habits: SemanticHabitRow[]; policy: SemanticDedupePolicy; provider: EmbeddingAdapter; signal?: AbortSignal; batchSize?: number; onProgress?: (progress: SemanticProgress) => void }): Promise<Map<string, PreparedEmbedding>> {
	const policy = sanitizePolicy(input.policy);
	assertProviderMatches(policy, input.provider);
	const prepared = new Map<string, PreparedEmbedding>();
	const missing: Array<{ habit: SemanticHabitRow; text: string; checksum: string }> = [];
	for (const habit of input.habits) {
		const text = habitEmbeddingInputV1({ condition: habit.condition, behavior: habit.behavior });
		const checksum = embeddingInputChecksum(text);
		const cached = getCachedHabitEmbedding(db, { userId: input.userId, habitId: habit.id, embeddingInputChecksum: checksum, habitRowChecksum: habit.checksum, provider: policy.provider, model: policy.model, dimensions: policy.dimensions });
		if (cached) prepared.set(habit.id, { habit, embeddingInputChecksum: checksum, vector: cached.vector, cached: true });
		else missing.push({ habit, text, checksum });
	}
	const batchSize = Math.max(1, Math.min(LOCAL_EMBEDDING_MAX_BATCH, Math.trunc(input.batchSize || 32)));
	let completed = input.habits.length - missing.length;
	input.onProgress?.({ phase: "embedding", completed, total: input.habits.length });
	for (let offset = 0; offset < missing.length; offset += batchSize) {
		throwIfAborted(input.signal);
		const batch = missing.slice(offset, offset + batchSize);
		const vectors = await input.provider.embed(batch.map((item) => item.text), { signal: input.signal });
		if (!Array.isArray(vectors) || vectors.length !== batch.length) throw new Error("Local embedding runtime returned wrong vector count");
		for (let index = 0; index < batch.length; index += 1) {
			const vector = vectors[index];
			if (!vector || vector.length !== policy.dimensions) throw new Error("Local embedding runtime returned wrong dimensions");
			prepared.set(batch[index].habit.id, { habit: batch[index].habit, embeddingInputChecksum: batch[index].checksum, vector: normalizedVector(vector), cached: false });
		}
		completed += batch.length;
		input.onProgress?.({ phase: "embedding", completed, total: input.habits.length });
	}
	throwIfAborted(input.signal);
	return prepared;
}

function persistPreparedEmbedding(db: any, input: { userId: string; prepared: PreparedEmbedding; policy: SemanticDedupePolicy; now: string }): CachedHabitEmbedding {
	return upsertCachedHabitEmbedding(db, { userId: input.userId, habitId: input.prepared.habit.id, embeddingInputChecksum: input.prepared.embeddingInputChecksum, habitRowChecksum: input.prepared.habit.checksum, provider: input.policy.provider, model: input.policy.model, dimensions: input.policy.dimensions, vector: input.prepared.vector, now: input.now });
}

function computeMatches(input: { target: SemanticHabitRow; comparators: SemanticHabitRow[]; prepared: Map<string, PreparedEmbedding>; policy: SemanticDedupePolicy }): SemanticDuplicateMatch[] {
	const target = input.prepared.get(input.target.id);
	if (!target) throw new Error("Prepared target embedding missing");
	const matches: SemanticDuplicateMatch[] = [];
	for (const row of input.comparators) {
		const other = input.prepared.get(row.id);
		if (!other) throw new Error("Prepared comparator embedding missing");
		const similarityBp = cosineBp(target.vector, other.vector);
		const strength = classifySimilarityBp(similarityBp, input.policy);
		if (strength !== "none") matches.push({ habit: row, similarityBp, strength });
	}
	return matches.sort((left, right) => (right.similarityBp - left.similarityBp) || left.habit.id.localeCompare(right.habit.id));
}

function writeActivationBlocks(db: any, input: { userId: string; target: SemanticHabitRow; matches: SemanticDuplicateMatch[]; policy: SemanticDedupePolicy; targetKind: string; now: string }): void {
	for (const match of input.matches) {
		const canonical = chooseCanonicalHabit(input.target, match.habit);
		const duplicate = canonical.id === input.target.id ? match.habit : input.target;
		const relation = upsertHabitDuplicate(db, { userId: input.userId, habitId: input.target.id, otherHabitId: match.habit.id, canonicalHabitId: canonical.id, duplicateHabitId: duplicate.id, similarityBp: match.similarityBp, thresholdBp: input.policy.reviewThresholdBp, provider: input.policy.provider, model: input.policy.model, dimensions: input.policy.dimensions, decision: "pending", data: { action: "activation_block", target_kind: input.targetKind, strength: match.strength, policy: policySummary(input.policy) }, now: input.now });
		if (input.target.status === "candidate") markCandidateDuplicateResolution(db, { userId: input.userId, habitId: input.target.id, relationId: relation.id, data: { action: "activation_block", matched_habit_id: match.habit.id, similarity_bp: match.similarityBp, canonical_habit_id: canonical.id }, now: input.now });
		insertHabitDuplicateAudit(db, { userId: input.userId, duplicateId: relation.id, targetKind: input.targetKind, targetId: input.target.id, action: "semantic_activation_block", before: null, after: relation, data: { similarity_bp: match.similarityBp, matched_habit_id: match.habit.id, policy: policySummary(input.policy) }, now: input.now });
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

export async function ensureHabitEmbedding(db: any, input: { userId: string; habit: SemanticHabitRow; policy: SemanticDedupePolicy; provider: EmbeddingAdapter; now: string; signal?: AbortSignal }): Promise<CachedHabitEmbedding> {
	const policy = sanitizePolicy(input.policy);
	const prepared = await prepareHabitEmbeddings(db, { userId: input.userId, habits: [input.habit], policy, provider: input.provider, signal: input.signal, batchSize: 1 });
	return persistPreparedEmbedding(db, { userId: input.userId, prepared: prepared.get(input.habit.id)!, policy, now: input.now });
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

export function reconcileSemanticDuplicateThresholds(db: any, input: { userId: string; policy?: Partial<SemanticDedupePolicy>; now: string }) {
	const policy = sanitizePolicy(input.policy);
	if (!policy.enabled) return { user_id: input.userId, checked: 0, dismissed: [], refreshed: [], enabled: false };
	const method = duplicateMethod({ provider: policy.provider, model: policy.model, dimensions: policy.dimensions });
	const pending = listHabitDuplicates(db, { userId: input.userId, decision: "pending" }).filter((row: any) => row.method === method);
	const dismissed: string[] = [];
	const refreshed: string[] = [];
	for (const row of pending) {
		const similarityBp = Number(row.similarity_bp);
		const previousThresholdBp = Number(row.threshold_bp);
		let existingData: any = {};
		try { existingData = JSON.parse(row.data_json || "{}"); } catch {}
		if (similarityBp < policy.reviewThresholdBp) {
			const data = { ...existingData, resolution: { action: "dismissed_threshold_change", reason: "below_current_review_threshold", resolved_at: input.now, previous_threshold_bp: previousThresholdBp, current_threshold_bp: policy.reviewThresholdBp } };
			const changed = updateHabitDuplicateDecision(db, { userId: input.userId, duplicateId: row.id, decision: "dismissed_threshold_change", data, thresholdBp: policy.reviewThresholdBp, now: input.now });
			insertHabitDuplicateAudit(db, { userId: input.userId, duplicateId: row.id, targetKind: "habit_duplicate", targetId: row.id, action: "dismiss_threshold_change", before: changed.before, after: changed.after, data: { previous_threshold_bp: previousThresholdBp, current_threshold_bp: policy.reviewThresholdBp, similarity_bp: similarityBp }, now: input.now });
			restoreCandidateDuplicateResolution(db, { userId: input.userId, habitId: row.habit_a, relationId: row.id, reviewStatus: "threshold_dismissed", data: { reason: "threshold_change" }, now: input.now });
			restoreCandidateDuplicateResolution(db, { userId: input.userId, habitId: row.habit_b, relationId: row.id, reviewStatus: "threshold_dismissed", data: { reason: "threshold_change" }, now: input.now });
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

export async function scanAndBackfillSemanticDuplicates(db: any, input: { userId: string; policy?: Partial<SemanticDedupePolicy>; provider?: EmbeddingAdapter; now: string; statuses?: string[]; signal?: AbortSignal; batchSize?: number; onProgress?: (progress: SemanticProgress) => void; beforeCommitForTest?: () => void; failAfterWritesForTest?: boolean }) {
	const policy = sanitizePolicy(input.policy);
	if (!policy.enabled) return { user_id: input.userId, checked: 0, relations: [], threshold_reconciliation: { checked: 0, dismissed: [], refreshed: [] }, enabled: false };
	if (!input.provider) throw new Error("Local embedding runtime unavailable");
	throwIfAborted(input.signal);
	const statuses = input.statuses || SEMANTIC_COMPARISON_STATUSES;
	const rows = selectSemanticHabitRows(db, { userId: input.userId, statuses }).filter((row) => row.status !== "archived" && row.status !== "suppressed_by_law");
	if (rows.length > MAX_SEMANTIC_SCAN_HABITS) throw new Error(`Duplicate scan is limited to ${MAX_SEMANTIC_SCAN_HABITS} current habits; archive unused habits and retry`);
	const pairCount = rows.length * (rows.length - 1) / 2;
	if (pairCount > MAX_SEMANTIC_SCAN_PAIRS) throw new Error("Duplicate scan pair limit exceeded");
	const method = duplicateMethod({ provider: policy.provider, model: policy.model, dimensions: policy.dimensions });
	const rowState = rowSnapshot(rows);
	const relationState = relationSnapshot(db, input.userId, method);
	input.onProgress?.({ phase: "snapshot", completed: rows.length, total: rows.length });
	const prepared = await prepareHabitEmbeddings(db, { userId: input.userId, habits: rows, policy, provider: input.provider, signal: input.signal, batchSize: input.batchSize, onProgress: input.onProgress });
	const proposed: Array<{ left: SemanticHabitRow; right: SemanticHabitRow; similarityBp: number; strength: "review" | "strong" }> = [];
	let compared = 0;
	input.onProgress?.({ phase: "comparing", completed: 0, total: pairCount });
	for (let leftIndex = 0; leftIndex < rows.length; leftIndex += 1) {
		for (let rightIndex = leftIndex + 1; rightIndex < rows.length; rightIndex += 1) {
			throwIfAborted(input.signal);
			const left = rows[leftIndex];
			const right = rows[rightIndex];
			if (left.polarity === right.polarity && !getKeptSeparateDuplicate(db, { userId: input.userId, habitId: left.id, otherHabitId: right.id, provider: policy.provider, model: policy.model, dimensions: policy.dimensions })) {
				const similarityBp = cosineBp(prepared.get(left.id)!.vector, prepared.get(right.id)!.vector);
				const strength = classifySimilarityBp(similarityBp, policy);
				if (strength !== "none") proposed.push({ left, right, similarityBp, strength });
			}
			compared += 1;
			if (compared % 128 === 0) {
				input.onProgress?.({ phase: "comparing", completed: compared, total: pairCount });
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		}
	}
	input.onProgress?.({ phase: "comparing", completed: compared, total: pairCount });
	throwIfAborted(input.signal);
	input.beforeCommitForTest?.();
	input.onProgress?.({ phase: "saving", completed: 0, total: proposed.length });
	const relations: any[] = [];
	let threshold_reconciliation: any;
	db.exec("BEGIN IMMEDIATE");
	try {
		throwIfAborted(input.signal);
		const freshRows = selectSemanticHabitRows(db, { userId: input.userId, statuses }).filter((row) => row.status !== "archived" && row.status !== "suppressed_by_law");
		if (rowSnapshot(freshRows) !== rowState || relationSnapshot(db, input.userId, method) !== relationState) throw new Error("Duplicate scan state changed; retry");
		for (const item of prepared.values()) persistPreparedEmbedding(db, { userId: input.userId, prepared: item, policy, now: input.now });
		threshold_reconciliation = reconcileSemanticDuplicateThresholds(db, { userId: input.userId, policy, now: input.now });
		for (let index = 0; index < proposed.length; index += 1) {
			const item = proposed[index];
			const canonical = chooseCanonicalHabit(item.left, item.right);
			const duplicate = canonical.id === item.left.id ? item.right : item.left;
			const relation = upsertHabitDuplicate(db, { userId: input.userId, habitId: item.left.id, otherHabitId: item.right.id, canonicalHabitId: canonical.id, duplicateHabitId: duplicate.id, similarityBp: item.similarityBp, thresholdBp: policy.reviewThresholdBp, provider: policy.provider, model: policy.model, dimensions: policy.dimensions, decision: "pending", data: { action: "scan_backfill", strength: item.strength, policy: policySummary(policy) }, now: input.now });
			if (item.left.status === "candidate") markCandidateDuplicateResolution(db, { userId: input.userId, habitId: item.left.id, relationId: relation.id, data: { action: "scan_backfill", matched_habit_id: item.right.id, similarity_bp: item.similarityBp, canonical_habit_id: canonical.id }, now: input.now });
			if (item.right.status === "candidate") markCandidateDuplicateResolution(db, { userId: input.userId, habitId: item.right.id, relationId: relation.id, data: { action: "scan_backfill", matched_habit_id: item.left.id, similarity_bp: item.similarityBp, canonical_habit_id: canonical.id }, now: input.now });
			insertHabitDuplicateAudit(db, { userId: input.userId, duplicateId: relation.id, targetKind: "habit_duplicate", targetId: relation.id, action: "semantic_scan_backfill", before: null, after: relation, data: { similarity_bp: item.similarityBp }, now: input.now });
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
