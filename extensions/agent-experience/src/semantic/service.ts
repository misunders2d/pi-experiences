import { chooseCanonicalHabit, classifySimilarityBp, cosineBp, embeddingInputChecksum, habitEmbeddingInputV1, normalizedVector } from "./core.ts";
import { duplicateMethod, getCachedHabitEmbedding, getKeptSeparateDuplicate, getSemanticHabitRow, insertHabitDuplicateAudit, listHabitDuplicates, markCandidateDuplicateResolution, restoreCandidateDuplicateResolution, selectSemanticHabitRows, updateHabitDuplicateDecision, upsertCachedHabitEmbedding, upsertHabitDuplicate } from "./storage.ts";
import type { CachedHabitEmbedding, EmbeddingAdapter, SemanticDedupePolicy, SemanticDuplicateMatch, SemanticGateDecision, SemanticHabitRow } from "./types.ts";

export const SEMANTIC_COMPARISON_STATUSES = ["active", "disabled", "candidate"];

export function sanitizePolicy(policy: Partial<SemanticDedupePolicy> | undefined): SemanticDedupePolicy {
	const rawReview = policy?.reviewThresholdBp === undefined ? 7500 : Math.trunc(Number(policy.reviewThresholdBp));
	const reviewThresholdBp = Number.isFinite(rawReview) ? Math.max(0, Math.min(10000, rawReview)) : 7500;
	const rawStrong = policy?.strongThresholdBp === undefined ? 8500 : Math.trunc(Number(policy.strongThresholdBp));
	const requestedStrongThresholdBp = Number.isFinite(rawStrong) ? Math.max(0, Math.min(10000, rawStrong)) : 8500;
	return {
		enabled: policy?.enabled === true,
		provider: String(policy?.provider || "openai-compatible"),
		model: String(policy?.model || "text-embedding-3-small"),
		dimensions: Math.max(1, Math.min(8192, Math.trunc(Number(policy?.dimensions ?? 1536)))) || 1536,
		reviewThresholdBp,
		strongThresholdBp: Math.max(reviewThresholdBp, requestedStrongThresholdBp),
		timeoutMs: Math.max(1, Math.min(120000, Math.trunc(Number(policy?.timeoutMs ?? 10000)))) || 10000,
		openAiCompatibleOptIn: policy?.openAiCompatibleOptIn === true,
	};
}

function policySummary(policy: SemanticDedupePolicy) {
	return { enabled: policy.enabled, provider: policy.provider, model: policy.model, dimensions: policy.dimensions, reviewThresholdBp: policy.reviewThresholdBp, strongThresholdBp: policy.strongThresholdBp };
}

function assertProviderMatches(policy: SemanticDedupePolicy, provider: EmbeddingAdapter): void {
	if (provider.provider !== policy.provider || provider.model !== policy.model || provider.dimensions !== policy.dimensions) throw new Error("Semantic embedding provider does not match configured policy");
}

export async function ensureHabitEmbedding(db: any, input: { userId: string; habit: SemanticHabitRow; policy: SemanticDedupePolicy; provider: EmbeddingAdapter; now: string; signal?: AbortSignal }): Promise<CachedHabitEmbedding> {
	const policy = sanitizePolicy(input.policy);
	assertProviderMatches(policy, input.provider);
	const text = habitEmbeddingInputV1({ condition: input.habit.condition, behavior: input.habit.behavior });
	const checksum = embeddingInputChecksum(text);
	const cached = getCachedHabitEmbedding(db, { userId: input.userId, habitId: input.habit.id, embeddingInputChecksum: checksum, habitRowChecksum: input.habit.checksum, provider: policy.provider, model: policy.model, dimensions: policy.dimensions });
	if (cached) return cached;
	const vectors = await input.provider.embed([text], { signal: input.signal });
	const vector = vectors[0];
	if (!vector) throw new Error("Semantic embedding provider returned no vector");
	if (vector.length !== policy.dimensions) throw new Error("Semantic embedding provider returned wrong dimensions");
	const normalized = normalizedVector(vector);
	return upsertCachedHabitEmbedding(db, { userId: input.userId, habitId: input.habit.id, embeddingInputChecksum: checksum, habitRowChecksum: input.habit.checksum, provider: policy.provider, model: policy.model, dimensions: policy.dimensions, vector: normalized, now: input.now });
}

export async function findSemanticDuplicateMatches(db: any, input: { userId: string; target: SemanticHabitRow; policy: SemanticDedupePolicy; provider: EmbeddingAdapter; now: string; statuses?: string[]; signal?: AbortSignal }): Promise<SemanticDuplicateMatch[]> {
	const policy = sanitizePolicy(input.policy);
	if (!policy.enabled) return [];
	const targetEmbedding = await ensureHabitEmbedding(db, { userId: input.userId, habit: input.target, policy, provider: input.provider, now: input.now, signal: input.signal });
	const rows = selectSemanticHabitRows(db, { userId: input.userId, statuses: input.statuses || SEMANTIC_COMPARISON_STATUSES })
		.filter((row) => row.id !== input.target.id)
		.filter((row) => row.status !== "archived" && row.status !== "suppressed_by_law");
	const matches: SemanticDuplicateMatch[] = [];
	for (const row of rows) {
		if (getKeptSeparateDuplicate(db, { userId: input.userId, habitId: input.target.id, otherHabitId: row.id, provider: policy.provider, model: policy.model, dimensions: policy.dimensions })) continue;
		const embedding = await ensureHabitEmbedding(db, { userId: input.userId, habit: row, policy, provider: input.provider, now: input.now, signal: input.signal });
		const similarityBp = cosineBp(targetEmbedding.vector, embedding.vector);
		const strength = classifySimilarityBp(similarityBp, policy);
		if (strength === "none") continue;
		matches.push({ habit: row, similarityBp, strength });
	}
	return matches.sort((a, b) => (b.similarityBp - a.similarityBp) || a.habit.id.localeCompare(b.habit.id));
}

export async function checkSemanticActivationGate(db: any, input: { userId: string; targetHabitId: string; policy?: Partial<SemanticDedupePolicy>; provider?: EmbeddingAdapter; now: string; signal?: AbortSignal; targetKind?: string }): Promise<SemanticGateDecision> {
	const policy = sanitizePolicy(input.policy);
	if (!policy.enabled) return { pass: true, reason: "disabled", matches: [], policy: policySummary(policy) };
	if (!input.provider) {
		insertHabitDuplicateAudit(db, { userId: input.userId, targetKind: input.targetKind || "habit", targetId: input.targetHabitId, action: "semantic_gate_unavailable", data: { policy: policySummary(policy), reason: "missing_provider" }, now: input.now });
		return { pass: false, reason: "semantic_unavailable", matches: [], policy: policySummary(policy) };
	}
	let target = getSemanticHabitRow(db, { userId: input.userId, habitId: input.targetHabitId });
	if (!target) throw new Error("Habit not found");
	let matches: SemanticDuplicateMatch[];
	try {
		matches = await findSemanticDuplicateMatches(db, { userId: input.userId, target, policy, provider: input.provider, now: input.now, statuses: ["active", "disabled"], signal: input.signal });
	} catch (error: any) {
		const unavailableReason = String(error?.message || error).slice(0, 300);
		insertHabitDuplicateAudit(db, { userId: input.userId, targetKind: input.targetKind || "habit", targetId: input.targetHabitId, action: "semantic_gate_unavailable", data: { policy: policySummary(policy), reason: unavailableReason }, now: input.now });
		return { pass: false, reason: "semantic_unavailable", matches: [], policy: policySummary(policy), error: unavailableReason } as any;
	}
	if (!matches.length) return { pass: true, reason: "pass", matches: [], policy: policySummary(policy) };
	for (const match of matches) {
		const canonical = chooseCanonicalHabit(target, match.habit);
		const duplicate = canonical.id === target.id ? match.habit : target;
		const relation = upsertHabitDuplicate(db, { userId: input.userId, habitId: target.id, otherHabitId: match.habit.id, canonicalHabitId: canonical.id, duplicateHabitId: duplicate.id, similarityBp: match.similarityBp, thresholdBp: policy.reviewThresholdBp, provider: policy.provider, model: policy.model, dimensions: policy.dimensions, decision: "pending", data: { action: "activation_block", target_kind: input.targetKind || "habit", strength: match.strength, policy: policySummary(policy), target_checksum: target.checksum, matched_checksum: match.habit.checksum }, now: input.now });
		if (target.status === "candidate") markCandidateDuplicateResolution(db, { userId: input.userId, habitId: target.id, relationId: relation.id, data: { action: "activation_block", matched_habit_id: match.habit.id, similarity_bp: match.similarityBp, canonical_habit_id: canonical.id }, now: input.now });
		insertHabitDuplicateAudit(db, { userId: input.userId, duplicateId: relation.id, targetKind: input.targetKind || "habit", targetId: target.id, action: "semantic_activation_block", before: null, after: relation, data: { similarity_bp: match.similarityBp, matched_habit_id: match.habit.id, policy: policySummary(policy) }, now: input.now });
	}
	return { pass: false, reason: "semantic_duplicate", matches, policy: policySummary(policy) };
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

export async function scanAndBackfillSemanticDuplicates(db: any, input: { userId: string; policy?: Partial<SemanticDedupePolicy>; provider?: EmbeddingAdapter; now: string; statuses?: string[]; signal?: AbortSignal }) {
	const policy = sanitizePolicy(input.policy);
	if (!policy.enabled) return { user_id: input.userId, checked: 0, relations: [], threshold_reconciliation: { checked: 0, dismissed: [], refreshed: [] }, enabled: false };
	if (!input.provider) throw new Error("Semantic embedding provider unavailable");
	const threshold_reconciliation = reconcileSemanticDuplicateThresholds(db, { userId: input.userId, policy, now: input.now });
	const rows = selectSemanticHabitRows(db, { userId: input.userId, statuses: input.statuses || SEMANTIC_COMPARISON_STATUSES })
		.filter((row) => row.status !== "archived" && row.status !== "suppressed_by_law");
	const relations: any[] = [];
	for (const row of rows) await ensureHabitEmbedding(db, { userId: input.userId, habit: row, policy, provider: input.provider, now: input.now, signal: input.signal });
	for (let i = 0; i < rows.length; i++) {
		for (let j = i + 1; j < rows.length; j++) {
			if (getKeptSeparateDuplicate(db, { userId: input.userId, habitId: rows[i].id, otherHabitId: rows[j].id, provider: policy.provider, model: policy.model, dimensions: policy.dimensions })) continue;
			const left = await ensureHabitEmbedding(db, { userId: input.userId, habit: rows[i], policy, provider: input.provider, now: input.now, signal: input.signal });
			const right = await ensureHabitEmbedding(db, { userId: input.userId, habit: rows[j], policy, provider: input.provider, now: input.now, signal: input.signal });
			const similarityBp = cosineBp(left.vector, right.vector);
			const strength = classifySimilarityBp(similarityBp, policy);
			if (strength === "none") continue;
			const canonical = chooseCanonicalHabit(rows[i], rows[j]);
			const duplicate = canonical.id === rows[i].id ? rows[j] : rows[i];
			const relation = upsertHabitDuplicate(db, { userId: input.userId, habitId: rows[i].id, otherHabitId: rows[j].id, canonicalHabitId: canonical.id, duplicateHabitId: duplicate.id, similarityBp, thresholdBp: policy.reviewThresholdBp, provider: policy.provider, model: policy.model, dimensions: policy.dimensions, decision: "pending", data: { action: "scan_backfill", strength, policy: policySummary(policy), left_checksum: rows[i].checksum, right_checksum: rows[j].checksum }, now: input.now });
			if (rows[i].status === "candidate") markCandidateDuplicateResolution(db, { userId: input.userId, habitId: rows[i].id, relationId: relation.id, data: { action: "scan_backfill", matched_habit_id: rows[j].id, similarity_bp: similarityBp, canonical_habit_id: canonical.id }, now: input.now });
			if (rows[j].status === "candidate") markCandidateDuplicateResolution(db, { userId: input.userId, habitId: rows[j].id, relationId: relation.id, data: { action: "scan_backfill", matched_habit_id: rows[i].id, similarity_bp: similarityBp, canonical_habit_id: canonical.id }, now: input.now });
			relations.push(relation);
		}
	}
	return { user_id: input.userId, checked: rows.length, relations, threshold_reconciliation, enabled: true };
}
