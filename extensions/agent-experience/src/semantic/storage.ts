import { canonicalJson, checksumJson, sha256Hex } from "../storage/checksum.ts";
import { normalizeUserId } from "../storage/private-root.ts";
import { containsUnredactedSensitiveText, redactJson } from "../storage/redaction.ts";
import { buildTypedStorageRow } from "../storage/sqlite.ts";
import { blobToVector, embeddingInputChecksum, habitEmbeddingInputV1, SEMANTIC_DUPLICATE_METHOD_VERSION, SEMANTIC_EMBEDDING_INPUT_VERSION, semanticPairKey, semanticWordingIdentityChecksum, vectorChecksum, vectorToBlob } from "./core.ts";
import type { CachedHabitEmbedding, SemanticHabitRow } from "./types.ts";

function boundedJson(value: unknown, max = 24000): string {
	const safe = redactJson(value ?? {});
	const text = canonicalJson(safe);
	if (text.length > max) throw new Error("Semantic dedupe JSON too large");
	if (containsUnredactedSensitiveText(text)) throw new Error("Semantic dedupe JSON contains unredacted sensitive text");
	return text;
}

function stableId(prefix: string, value: unknown): string {
	return `${prefix}-${sha256Hex(canonicalJson(value)).slice(0, 40)}`;
}

function embeddingRowChecksum(row: { user_id: string; habit_id: string; embedding_input_version: string; embedding_input_checksum: string; habit_row_checksum: string; provider: string; model: string; dimensions: number; vector_checksum: string; created_at: string; updated_at: string }): string {
	return checksumJson({ table: "habit_embeddings", row });
}

function duplicateChecksum(row: { user_id: string; pair_key: string; habit_a: string; habit_b: string; canonical_habit_id: string | null; duplicate_habit_id: string | null; similarity_bp: number; threshold_bp: number; method: string; provider: string | null; model: string | null; dimensions: number | null; decision: string; data_json: string; created_at: string; updated_at: string; decided_at: string | null }): string {
	return checksumJson({ table: "habit_duplicates", row });
}

function duplicateRowChecksumValid(row: any): boolean {
	if (!row || typeof row !== "object") return false;
	const expected = duplicateChecksum({
		user_id: row.user_id,
		pair_key: row.pair_key,
		habit_a: row.habit_a,
		habit_b: row.habit_b,
		canonical_habit_id: row.canonical_habit_id ?? null,
		duplicate_habit_id: row.duplicate_habit_id ?? null,
		similarity_bp: Number(row.similarity_bp),
		threshold_bp: Number(row.threshold_bp),
		method: row.method,
		provider: row.provider ?? null,
		model: row.model ?? null,
		dimensions: row.dimensions === null || row.dimensions === undefined ? null : Number(row.dimensions),
		decision: row.decision,
		data_json: row.data_json,
		created_at: row.created_at,
		updated_at: row.updated_at,
		decided_at: row.decided_at ?? null,
	});
	return expected === row.checksum;
}

function auditChecksum(row: { user_id: string; duplicate_id: string | null; target_kind: string; target_id: string | null; action: string; before_json: string; after_json: string; data_json: string; created_at: string }): string {
	return checksumJson({ table: "habit_duplicate_audit", row });
}

function normalizeStatuses(statuses: string[]): string[] {
	return [...new Set(statuses.map((status) => String(status)).filter(Boolean))];
}

export function selectSemanticHabitRows(db: any, input: { userId: string; statuses: string[]; ids?: string[] }): SemanticHabitRow[] {
	const userId = normalizeUserId(input.userId);
	const statuses = normalizeStatuses(input.statuses);
	if (!statuses.length) return [];
	const statusPlaceholders = statuses.map(() => "?").join(",");
	const idFilter = input.ids?.length ? ` AND id IN (${input.ids.map(() => "?").join(",")})` : "";
	return db.prepare(`SELECT id, user_id, status, condition, behavior, polarity, checksum, created_at, updated_at, data_json FROM habits WHERE user_id = ? AND status IN (${statusPlaceholders})${idFilter} ORDER BY created_at, id`)
		.all(userId, ...statuses, ...(input.ids || []))
		.map((row: any) => ({ ...row, polarity: Number(row.polarity) }));
}

export function getSemanticHabitRow(db: any, input: { userId: string; habitId: string }): SemanticHabitRow | null {
	const row = db.prepare("SELECT id, user_id, status, condition, behavior, polarity, checksum, created_at, updated_at, data_json FROM habits WHERE user_id = ? AND id = ?").get(normalizeUserId(input.userId), input.habitId);
	return row ? { ...row, polarity: Number(row.polarity) } : null;
}

export function getCachedHabitEmbedding(db: any, input: { userId: string; habitId: string; embeddingInputVersion?: string; embeddingInputChecksum: string; habitRowChecksum: string; provider: string; model: string; dimensions: number }): CachedHabitEmbedding | null {
	const embeddingInputVersion = input.embeddingInputVersion || SEMANTIC_EMBEDDING_INPUT_VERSION;
	const row = db.prepare(`SELECT * FROM habit_embeddings WHERE user_id = ? AND habit_id = ? AND embedding_input_version = ? AND embedding_input_checksum = ? AND habit_row_checksum = ? AND provider = ? AND model = ? AND dimensions = ?`)
		.get(normalizeUserId(input.userId), input.habitId, embeddingInputVersion, input.embeddingInputChecksum, input.habitRowChecksum, input.provider, input.model, input.dimensions);
	if (!row) return null;
	const expected = embeddingRowChecksum({ user_id: row.user_id, habit_id: row.habit_id, embedding_input_version: row.embedding_input_version, embedding_input_checksum: row.embedding_input_checksum, habit_row_checksum: row.habit_row_checksum, provider: row.provider, model: row.model, dimensions: Number(row.dimensions), vector_checksum: row.vector_checksum, created_at: row.created_at, updated_at: row.updated_at });
	if (expected !== row.row_checksum) return null;
	const vector = blobToVector(row.vector_blob, Number(row.dimensions));
	if (vectorChecksum(vector) !== row.vector_checksum) return null;
	return { ...row, dimensions: Number(row.dimensions), vector };
}

export function upsertCachedHabitEmbedding(db: any, input: { userId: string; habitId: string; embeddingInputVersion?: string; embeddingInputChecksum: string; habitRowChecksum: string; provider: string; model: string; dimensions: number; vector: Float32Array; now: string }): CachedHabitEmbedding {
	const userId = normalizeUserId(input.userId);
	const embeddingInputVersion = input.embeddingInputVersion || SEMANTIC_EMBEDDING_INPUT_VERSION;
	if (!Number.isInteger(input.dimensions) || input.dimensions < 1 || input.dimensions > 8192) throw new Error("Invalid embedding dimensions");
	if (input.vector.length !== input.dimensions) throw new Error("Embedding vector dimension mismatch");
	const existing = getCachedHabitEmbedding(db, { ...input, embeddingInputVersion });
	const vector_checksum = vectorChecksum(input.vector);
	const created_at = existing?.created_at || input.now;
	const rowBase = { user_id: userId, habit_id: input.habitId, embedding_input_version: embeddingInputVersion, embedding_input_checksum: input.embeddingInputChecksum, habit_row_checksum: input.habitRowChecksum, provider: input.provider, model: input.model, dimensions: input.dimensions, vector_checksum, created_at, updated_at: input.now };
	const row_checksum = embeddingRowChecksum(rowBase);
	db.prepare(`INSERT INTO habit_embeddings (user_id, habit_id, embedding_input_version, embedding_input_checksum, habit_row_checksum, provider, model, dimensions, vector_blob, vector_checksum, created_at, updated_at, row_checksum)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, habit_id, provider, model, dimensions, embedding_input_version) DO UPDATE SET embedding_input_checksum=excluded.embedding_input_checksum, habit_row_checksum=excluded.habit_row_checksum, vector_blob=excluded.vector_blob, vector_checksum=excluded.vector_checksum, created_at=excluded.created_at, updated_at=excluded.updated_at, row_checksum=excluded.row_checksum`)
		.run(userId, input.habitId, embeddingInputVersion, input.embeddingInputChecksum, input.habitRowChecksum, input.provider, input.model, input.dimensions, vectorToBlob(input.vector), vector_checksum, created_at, input.now, row_checksum);
	const saved = getCachedHabitEmbedding(db, { ...input, embeddingInputVersion });
	if (!saved) throw new Error("Embedding cache write failed");
	return saved;
}

export function duplicateMethod(input: { provider: string; model: string; dimensions: number }): string {
	return `embedding:${input.provider}:${input.model}:${input.dimensions}:${SEMANTIC_DUPLICATE_METHOD_VERSION}`;
}

export function currentDuplicateWordingHashes(db: any, input: { userId: string; habitId: string; otherHabitId: string }): Record<string, string> | null {
	const userId = normalizeUserId(input.userId);
	const pair = semanticPairKey(input.habitId, input.otherHabitId);
	const habits = db.prepare("SELECT id, condition, behavior, polarity FROM habits WHERE user_id = ? AND id IN (?, ?) ORDER BY id").all(userId, pair.habitA, pair.habitB);
	if (habits.length !== 2) return null;
	return Object.fromEntries(habits.map((habit: any) => [habit.id, semanticWordingIdentityChecksum({ condition: habit.condition, behavior: habit.behavior, polarity: Number(habit.polarity) })]));
}

export function duplicateWordingHashesMatch(db: any, input: { userId: string; relation: any }): boolean {
	if (!duplicateRowChecksumValid(input.relation)) return false;
	const current = currentDuplicateWordingHashes(db, { userId: input.userId, habitId: input.relation.habit_a, otherHabitId: input.relation.habit_b });
	if (!current) return false;
	let data: any = {};
	try { data = JSON.parse(input.relation.data_json || "{}"); } catch {}
	const stored = data.wording_hashes;
	if (!stored || typeof stored !== "object" || Array.isArray(stored)) return false;
	return Object.keys(current).every((habitId) => typeof stored[habitId] === "string" && stored[habitId] === current[habitId]);
}

export function upsertHabitDuplicate(db: any, input: { userId: string; habitId: string; otherHabitId: string; canonicalHabitId: string; duplicateHabitId: string; similarityBp: number; thresholdBp: number; provider: string; model: string; dimensions: number; decision?: "pending" | "merged" | "superseded" | "kept_separate" | "archived_duplicate" | "dismissed_threshold_change"; data?: unknown; now: string }) {
	const userId = normalizeUserId(input.userId);
	const pair = semanticPairKey(input.habitId, input.otherHabitId);
	const method = duplicateMethod(input);
	const existing = db.prepare("SELECT * FROM habit_duplicates WHERE user_id = ? AND pair_key = ? AND method = ?").get(userId, pair.pairKey, method);
	const decision = input.decision || existing?.decision || "pending";
	const created_at = existing?.created_at || input.now;
	const decided_at = decision === "pending" ? null : input.now;
	const wordingHashes = currentDuplicateWordingHashes(db, { userId, habitId: pair.habitA, otherHabitId: pair.habitB });
	if (!wordingHashes) throw new Error("Duplicate habits changed; retry");
	const suppliedData = typeof input.data === "object" && input.data && !Array.isArray(input.data) ? input.data as Record<string, unknown> : {};
	const data_json = boundedJson({ ...suppliedData, wording_hashes: wordingHashes });
	const base = { user_id: userId, pair_key: pair.pairKey, habit_a: pair.habitA, habit_b: pair.habitB, canonical_habit_id: input.canonicalHabitId, duplicate_habit_id: input.duplicateHabitId, similarity_bp: input.similarityBp, threshold_bp: input.thresholdBp, method, provider: input.provider, model: input.model, dimensions: input.dimensions, decision, data_json, created_at, updated_at: input.now, decided_at };
	const checksum = duplicateChecksum(base);
	const id = existing?.id || stableId("habit-dup", { user_id: userId, pair_key: pair.pairKey, method });
	db.prepare(`INSERT INTO habit_duplicates (id, user_id, pair_key, habit_a, habit_b, canonical_habit_id, duplicate_habit_id, similarity_bp, threshold_bp, method, provider, model, dimensions, decision, data_json, checksum, created_at, updated_at, decided_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, pair_key, method) DO UPDATE SET canonical_habit_id=excluded.canonical_habit_id, duplicate_habit_id=excluded.duplicate_habit_id, similarity_bp=excluded.similarity_bp, threshold_bp=excluded.threshold_bp, provider=excluded.provider, model=excluded.model, dimensions=excluded.dimensions, decision=excluded.decision, data_json=excluded.data_json, checksum=excluded.checksum, updated_at=excluded.updated_at, decided_at=excluded.decided_at`)
		.run(id, userId, pair.pairKey, pair.habitA, pair.habitB, input.canonicalHabitId, input.duplicateHabitId, input.similarityBp, input.thresholdBp, method, input.provider, input.model, input.dimensions, decision, data_json, checksum, created_at, input.now, decided_at);
	return db.prepare("SELECT * FROM habit_duplicates WHERE id = ?").get(id);
}

export function getKeptSeparateDuplicate(db: any, input: { userId: string; habitId: string; otherHabitId: string; provider: string; model: string; dimensions: number }) {
	const userId = normalizeUserId(input.userId);
	const pair = semanticPairKey(input.habitId, input.otherHabitId);
	const habits = db.prepare("SELECT id, condition, behavior FROM habits WHERE user_id = ? AND id IN (?, ?) ORDER BY id").all(userId, pair.habitA, pair.habitB);
	if (habits.length !== 2) return undefined;
	const legacyChecksums = new Map(habits.map((habit: any) => [habit.id, embeddingInputChecksum(habitEmbeddingInputV1({ condition: habit.condition, behavior: habit.behavior }), SEMANTIC_EMBEDDING_INPUT_VERSION)]));
	const prior = db.prepare("SELECT * FROM habit_duplicates WHERE user_id = ? AND pair_key = ? AND decision = 'kept_separate' ORDER BY updated_at DESC, id").all(userId, pair.pairKey);
	for (const relation of prior) {
		if (!duplicateRowChecksumValid(relation)) continue;
		if (duplicateWordingHashesMatch(db, { userId, relation })) return relation;
		if (!String(relation.method || "").endsWith(`:${SEMANTIC_EMBEDDING_INPUT_VERSION}`)) continue;
		const cached = db.prepare("SELECT habit_id, embedding_input_checksum, habit_row_checksum FROM habit_embeddings WHERE user_id = ? AND habit_id IN (?, ?) AND provider = ? AND model = ? AND dimensions = ? AND embedding_input_version = ?").all(userId, pair.habitA, pair.habitB, relation.provider, relation.model, Number(relation.dimensions), SEMANTIC_EMBEDDING_INPUT_VERSION);
		if (cached.length === 2 && cached.every((row: any) => legacyChecksums.get(row.habit_id) === row.embedding_input_checksum && !!getCachedHabitEmbedding(db, { userId, habitId: row.habit_id, embeddingInputVersion: SEMANTIC_EMBEDDING_INPUT_VERSION, embeddingInputChecksum: row.embedding_input_checksum, habitRowChecksum: row.habit_row_checksum, provider: relation.provider, model: relation.model, dimensions: Number(relation.dimensions) }))) return relation;
	}
	return undefined;
}

function updateCandidateReviewStatus(db: any, input: { userId: string; habitId: string; expectedReviewStatus?: string; nextReviewStatus: string; data?: unknown; now: string }) {
	const userId = normalizeUserId(input.userId);
	const before = db.prepare("SELECT * FROM habits WHERE user_id = ? AND id = ? AND status = 'candidate'").get(userId, input.habitId);
	if (!before) return { updated: false, before: null, after: null };
	let existingData: any = {};
	try { existingData = JSON.parse(before.data_json || "{}"); } catch {}
	if (input.expectedReviewStatus !== undefined && existingData.review_status !== input.expectedReviewStatus) return { updated: false, before, after: before };
	if (existingData.review_status === input.nextReviewStatus) return { updated: false, before, after: before };
	const data = { ...existingData, record_kind: before.record_kind, schema_version: before.schema_version, status: before.status, habit_id: before.habit_id, condition: before.condition, behavior: before.behavior, polarity: before.polarity, confidence_bp: before.confidence_bp, activation: before.activation, staleness: before.staleness, active: false, injectable: false, review_status: input.nextReviewStatus, ...(typeof input.data === "object" && input.data && !Array.isArray(input.data) ? input.data as Record<string, unknown> : {}) };
	const row = buildTypedStorageRow("habits", { id: before.id, userId, data, createdAt: before.created_at, updatedAt: input.now });
	const result = db.prepare("UPDATE habits SET record_kind=?, schema_version=?, status=?, habit_id=?, condition=?, behavior=?, polarity=?, confidence_bp=?, activation=?, staleness=?, data_json=?, checksum=?, updated_at=? WHERE user_id=? AND id=? AND status='candidate' AND checksum=?")
		.run(row.record_kind, row.schema_version, row.status, row.habit_id, row.condition, row.behavior, row.polarity, row.confidence_bp, row.activation, row.staleness, row.data_json, row.checksum, row.updated_at, userId, before.id, before.checksum);
	if (result.changes !== 1) throw new Error("Candidate duplicate-route update failed");
	const after = db.prepare("SELECT * FROM habits WHERE user_id = ? AND id = ?").get(userId, before.id);
	return { updated: true, before, after };
}

export function markCandidateDuplicateResolution(db: any, input: { userId: string; habitId: string; relationId: string; data?: unknown; now: string }) {
	const userId = normalizeUserId(input.userId);
	const before = db.prepare("SELECT data_json FROM habits WHERE user_id = ? AND id = ? AND status = 'candidate'").get(userId, input.habitId);
	if (!before) return { updated: false, before: null, after: null };
	let existingData: any = {};
	try { existingData = JSON.parse(before.data_json || "{}"); } catch {}
	const existingSemantic = existingData.semantic_duplicate && typeof existingData.semantic_duplicate === "object" ? existingData.semantic_duplicate : {};
	const previousReviewStatus = existingData.review_status === "duplicate_resolution"
		? String(existingSemantic.previous_review_status || "candidate")
		: String(existingData.review_status || "candidate");
	return updateCandidateReviewStatus(db, { userId, habitId: input.habitId, expectedReviewStatus: undefined, nextReviewStatus: "duplicate_resolution", data: { semantic_duplicate: { ...existingSemantic, ...(typeof input.data === "object" && input.data && !Array.isArray(input.data) ? input.data as Record<string, unknown> : {}), previous_review_status: previousReviewStatus, duplicate_relation_id: input.relationId, routed_at: input.now } }, now: input.now });
}

export function restoreCandidateDuplicateResolution(db: any, input: { userId: string; habitId: string; relationId: string; reviewStatus: string; data?: unknown; now: string }) {
	const userId = normalizeUserId(input.userId);
	const before = db.prepare("SELECT * FROM habits WHERE user_id = ? AND id = ? AND status = 'candidate'").get(userId, input.habitId);
	if (!before) return { updated: false, before: null, after: null, pendingRelations: 0 };
	let existingData: any = {};
	try { existingData = JSON.parse(before.data_json || "{}"); } catch {}
	if (existingData.review_status !== "duplicate_resolution") return { updated: false, before, after: before, pendingRelations: 0 };
	const pendingRelations = Number(db.prepare("SELECT COUNT(*) AS count FROM habit_duplicates WHERE user_id = ? AND decision = 'pending' AND (habit_a = ? OR habit_b = ?)").get(userId, input.habitId, input.habitId)?.count || 0);
	if (pendingRelations > 0) return { updated: false, before, after: before, pendingRelations };
	const approved = !!existingData.approved_identity;
	const previous = String(existingData.semantic_duplicate?.previous_review_status || "candidate");
	const allowedPrevious = new Set(["candidate", "collecting_evidence", "kept_separate", "approved_pending_eligibility", "approved_pending_conflict", "approved_pending_law_blocked"]);
	const nextReviewStatus = approved
		? (previous.startsWith("approved_pending_") ? previous : "approved_pending_eligibility")
		: input.reviewStatus === "kept_separate" ? "kept_separate"
		: allowedPrevious.has(previous) ? previous
		: "candidate";
	return { ...updateCandidateReviewStatus(db, { userId, habitId: input.habitId, expectedReviewStatus: "duplicate_resolution", nextReviewStatus, data: { ...(approved ? { approved_pending_reason: "duplicate_resolved" } : {}), semantic_duplicate_resolution: { ...(typeof input.data === "object" && input.data && !Array.isArray(input.data) ? input.data as Record<string, unknown> : {}), duplicate_relation_id: input.relationId, restored_at: input.now } }, now: input.now }), pendingRelations: 0 };
}

export function listHabitDuplicates(db: any, input: { userId: string; decision?: string }) {
	const userId = normalizeUserId(input.userId);
	if (input.decision) return db.prepare("SELECT * FROM habit_duplicates WHERE user_id = ? AND decision = ? ORDER BY updated_at DESC, id").all(userId, input.decision);
	return db.prepare("SELECT * FROM habit_duplicates WHERE user_id = ? ORDER BY updated_at DESC, id").all(userId);
}

export function updateHabitDuplicateDecision(db: any, input: { userId: string; duplicateId: string; expectedChecksum?: string; decision: "pending" | "merged" | "superseded" | "kept_separate" | "archived_duplicate" | "dismissed_threshold_change"; data?: unknown; now: string; canonicalHabitId?: string | null; duplicateHabitId?: string | null; thresholdBp?: number; similarityBp?: number }) {
	const userId = normalizeUserId(input.userId);
	const before = db.prepare("SELECT * FROM habit_duplicates WHERE user_id = ? AND id = ?").get(userId, input.duplicateId);
	if (!before) throw new Error("Duplicate item not found");
	if (input.expectedChecksum !== undefined && before.checksum !== input.expectedChecksum) throw new Error("Duplicate item changed; refresh required");
	const data_json = boundedJson(input.data ?? JSON.parse(before.data_json || "{}"));
	const afterBase = {
		user_id: before.user_id,
		pair_key: before.pair_key,
		habit_a: before.habit_a,
		habit_b: before.habit_b,
		canonical_habit_id: input.canonicalHabitId === undefined ? before.canonical_habit_id : input.canonicalHabitId,
		duplicate_habit_id: input.duplicateHabitId === undefined ? before.duplicate_habit_id : input.duplicateHabitId,
		similarity_bp: input.similarityBp === undefined ? Number(before.similarity_bp) : Number(input.similarityBp),
		threshold_bp: input.thresholdBp === undefined ? Number(before.threshold_bp) : Number(input.thresholdBp),
		method: before.method,
		provider: before.provider,
		model: before.model,
		dimensions: before.dimensions === null ? null : Number(before.dimensions),
		decision: input.decision,
		data_json,
		created_at: before.created_at,
		updated_at: input.now,
		decided_at: input.decision === "pending" ? null : input.now,
	};
	const checksum = duplicateChecksum(afterBase);
	const result = db.prepare("UPDATE habit_duplicates SET canonical_habit_id=?, duplicate_habit_id=?, similarity_bp=?, threshold_bp=?, decision=?, data_json=?, checksum=?, updated_at=?, decided_at=? WHERE user_id=? AND id=? AND checksum=?")
		.run(afterBase.canonical_habit_id, afterBase.duplicate_habit_id, afterBase.similarity_bp, afterBase.threshold_bp, afterBase.decision, data_json, checksum, input.now, afterBase.decided_at, userId, before.id, before.checksum);
	if (result.changes !== 1) throw new Error("Duplicate item update failed");
	const after = db.prepare("SELECT * FROM habit_duplicates WHERE user_id = ? AND id = ?").get(userId, before.id);
	return { before, after };
}

export function insertHabitDuplicateAudit(db: any, input: { userId: string; duplicateId?: string | null; targetKind: string; targetId?: string | null; action: string; before?: unknown; after?: unknown; data?: unknown; now: string }) {
	const userId = normalizeUserId(input.userId);
	const before_json = boundedJson(input.before ?? null);
	const after_json = boundedJson(input.after ?? null);
	const data_json = boundedJson(input.data ?? {});
	const base = { user_id: userId, duplicate_id: input.duplicateId ?? null, target_kind: input.targetKind, target_id: input.targetId ?? null, action: input.action, before_json, after_json, data_json, created_at: input.now };
	const checksum = auditChecksum(base);
	const id = stableId("habit-dup-audit", { ...base, checksum });
	const existing = db.prepare("SELECT id, checksum FROM habit_duplicate_audit WHERE id = ?").get(id);
	if (existing) {
		if (existing.checksum !== checksum) throw new Error("Habit duplicate audit collision");
		return { id, inserted: false };
	}
	db.prepare("INSERT INTO habit_duplicate_audit (id, user_id, duplicate_id, target_kind, target_id, action, before_json, after_json, data_json, checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.run(id, userId, input.duplicateId ?? null, input.targetKind, input.targetId ?? null, input.action, before_json, after_json, data_json, checksum, input.now);
	return { id, inserted: true };
}
