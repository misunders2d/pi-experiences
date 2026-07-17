import { canonicalJson, checksumJson, sha256Hex } from "./storage/checksum.ts";
import { normalizeUserId } from "./storage/private-root.ts";
import { containsUnredactedSensitiveText, redactJson, redactText } from "./storage/redaction.ts";
import { buildTypedStorageRow } from "./storage/sqlite.ts";
import { activationEligibilityFromHabit, checkHabitConflict, checkHabitLaw, revalidateLawSnapshotSync, type LawSnapshot } from "./review.ts";
import { runAtomicSemanticActivation } from "./semantic/service.ts";
import type { EmbeddingAdapter, SemanticDedupePolicy } from "./semantic/types.ts";
import type { AgentExperienceConfig } from "./config.ts";
import {
	embedSelectorPromptQueries,
	readSelectorConditionVectors,
	retrieveSelectorCandidates,
	selectorConditionIdentityChecksum,
	unionRetrievedSelectorCandidates,
	type RetrievedSelectorCandidate,
} from "./selector-vector.ts";
import {
	MAX_STEERING_CONTEXT_MESSAGES,
	MAX_STEERING_CONTEXT_MESSAGE_CHARS,
	MAX_STEERING_CONTEXT_TOTAL_CHARS,
	type SteeringContextTurn,
} from "./steering-context.ts";

export interface SelectorModelAdapter {
	select(input: { prompt: string; candidateIds: string[]; timeoutMs: number; model: string; signal?: AbortSignal }): Promise<unknown>;
}

export interface SelectorCandidate {
	id: string;
	user_id: string;
	condition: string;
	behavior: string;
	polarity: number;
	confidence_bp: number;
	activation: number;
	staleness: number;
	checksum: string;
	law_hash?: string;
}

export interface SelectorJudgment {
	id: string;
	confidence_bp: number;
}

const SELECTOR_JUDGMENT_REASONS = new Set([
	"current_applicability",
	"context_only_applicability",
	"mere_mention",
	"quoted_text",
	"negated",
	"generic_wording",
	"hypothetical_or_future",
	"not_currently_relevant",
]);

function parseJson(text: string | null | undefined): any {
	try {
		return JSON.parse(String(text || "{}"));
	} catch {
		return {};
	}
}

function stableId(prefix: string, value: unknown): string {
	return `${prefix}-${sha256Hex(canonicalJson(value)).slice(0, 40)}`;
}

function boundedJson(value: unknown, max = 12000): string {
	const text = canonicalJson(redactJson(value ?? {}));
	if (text.length > max) throw new Error("Selector payload too large");
	if (containsUnredactedSensitiveText(text)) throw new Error("Selector payload contains unredacted sensitive text");
	return text;
}

function promptHash(_prompt: string): string {
	// Prompt text, hashes, vectors, similarities, and other derivatives are never
	// persisted. This fixed sentinel is audit-compatible but not user-content-derived.
	return "omitted";
}

function hitLogChecksum(row: { user_id: string; habit_id: string | null; action: string; selected: number; reason: string; confidence_bp: number; latency_ms: number; prompt_hash: string; data_json: string; created_at: string }): string {
	return checksumJson({ table: "selector_hit_log", row });
}

export function isValidSelectorHitLog(row: any): boolean {
	if (!row) return false;
	const expected = hitLogChecksum({ user_id: row.user_id, habit_id: row.habit_id ?? null, action: row.action, selected: Number(row.selected), reason: row.reason, confidence_bp: Number(row.confidence_bp), latency_ms: Number(row.latency_ms), prompt_hash: row.prompt_hash, data_json: row.data_json, created_at: row.created_at });
	return expected === row.checksum;
}

export function insertSelectorHitLog(db: any, input: { userId: string; habitId?: string | null; action: string; selected: boolean; reason: string; confidenceBp?: number; latencyMs?: number; promptHash: string; data?: unknown; createdAt: string }) {
	const userId = normalizeUserId(input.userId);
	const row = {
		user_id: userId,
		habit_id: input.habitId ?? null,
		action: input.action,
		selected: input.selected ? 1 : 0,
		reason: String(input.reason).slice(0, 160),
		confidence_bp: Math.max(0, Math.min(10000, Math.trunc(input.confidenceBp ?? 0))),
		latency_ms: Math.max(0, Math.trunc(input.latencyMs ?? 0)),
		prompt_hash: input.promptHash,
		data_json: boundedJson(input.data ?? {}),
		created_at: input.createdAt,
	};
	const checksum = hitLogChecksum(row);
	const id = stableId("selector-hit", { ...row, checksum });
	db.prepare("INSERT INTO selector_hit_log (id, user_id, habit_id, action, selected, reason, confidence_bp, latency_ms, prompt_hash, data_json, checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.run(id, row.user_id, row.habit_id, row.action, row.selected, row.reason, row.confidence_bp, row.latency_ms, row.prompt_hash, row.data_json, checksum, row.created_at);
	return { id, checksum, ...row };
}

function selectorCandidateFromRow(row: any): SelectorCandidate {
	const data = parseJson(row.data_json);
	return redactJson({
		id: row.id,
		user_id: row.user_id,
		condition: row.condition || "",
		behavior: row.behavior || "",
		polarity: Number(row.polarity),
		confidence_bp: Number(row.confidence_bp),
		activation: Number(row.activation),
		staleness: Number(row.staleness),
		checksum: row.checksum,
		law_hash: typeof data.law_hash === "string" ? data.law_hash : undefined,
	}) as SelectorCandidate;
}

function assertValidHabitStorageRow(row: any): void {
	const data = parseJson(row.data_json);
	const rebuilt = buildTypedStorageRow("habits", {
		id: row.id,
		userId: row.user_id,
		data: {
			...data,
			record_kind: row.record_kind,
			schema_version: Number(row.schema_version),
			status: row.status,
			habit_id: row.habit_id,
			condition: row.condition,
			behavior: row.behavior,
			polarity: Number(row.polarity),
			confidence_bp: Number(row.confidence_bp),
			activation: Number(row.activation),
			staleness: Number(row.staleness),
		},
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	});
	if (rebuilt.checksum !== row.checksum) throw new Error("selector_habit_integrity_failed");
}

export function selectActiveSelectorSnapshot(db: any, input: { userId: string }): SelectorCandidate[] {
	const userId = normalizeUserId(input.userId);
	return db.prepare("SELECT * FROM habits WHERE user_id = ? AND status = 'active' ORDER BY id").all(userId)
		.map((row: any) => {
			assertValidHabitStorageRow(row);
			return selectorCandidateFromRow(row);
		});
}

export function filterEligibleSelectorCandidates(candidates: SelectorCandidate[], input: { minConfidenceBp?: number; stalenessMax?: number }): SelectorCandidate[] {
	const minConfidence = Math.max(0, Math.min(10000, Math.trunc(input.minConfidenceBp ?? 0)));
	const stalenessMax = Number.isFinite(input.stalenessMax) ? Number(input.stalenessMax) : Number.POSITIVE_INFINITY;
	return candidates
		.filter((candidate) => candidate.confidence_bp >= minConfidence && candidate.staleness <= stalenessMax)
		.sort((left, right) => right.confidence_bp - left.confidence_bp || left.id.localeCompare(right.id));
}

function boundedPromptSummary(prompt: string): string {
	const summary = redactText(prompt).trim().replace(/\s+/g, " ").slice(0, 500);
	if (containsUnredactedSensitiveText(summary)) throw new Error("Selector prompt contains unredacted sensitive text");
	return summary;
}

function boundedCondition(condition: string): string {
	const text = redactText(condition).trim().replace(/\s+/g, " ").slice(0, 500);
	if (containsUnredactedSensitiveText(text)) throw new Error("Selector condition contains unredacted sensitive text");
	return text;
}

function boundedSelectorContextTurns(turns: SteeringContextTurn[] | undefined): SteeringContextTurn[] {
	if (!turns?.length) return [];
	if (!Array.isArray(turns) || turns.length > MAX_STEERING_CONTEXT_MESSAGES) throw new Error("Selector context is invalid");
	const bounded = turns.map((turn) => {
		if (!turn || (turn.role !== "user" && turn.role !== "assistant") || typeof turn.text !== "string") throw new Error("Selector context is invalid");
		const text = redactText(turn.text).trim().replace(/\s+/g, " ").slice(0, MAX_STEERING_CONTEXT_MESSAGE_CHARS);
		if (!text || containsUnredactedSensitiveText(text)) throw new Error("Selector context contains unredacted sensitive text");
		return { role: turn.role, text };
	});
	if (bounded.reduce((total, turn) => total + turn.text.length, 0) > MAX_STEERING_CONTEXT_TOTAL_CHARS) throw new Error("Selector context is too large");
	const redacted = redactJson(bounded);
	if (containsUnredactedSensitiveText(redacted)) throw new Error("Selector context contains unredacted sensitive text");
	return redacted;
}

function buildContextualRetrievalPrompt(prompt: string, contextTurns: SteeringContextTurn[]): string | undefined {
	if (!contextTurns.length) return undefined;
	return [...contextTurns.map((turn) => `${turn.role}: ${turn.text}`), `current_user: ${prompt}`].join("\n");
}

export function buildSelectorPrompt(candidates: SelectorCandidate[], input: { prompt: string; maxHabits: number; contextTurns?: SteeringContextTurn[] }): string {
	const payload = {
		schema_version: 3,
		task: "judge_current_habit_applicability_with_context",
		max_selected: Math.max(0, Math.min(3, Math.trunc(input.maxHabits))),
		current_user_request: boundedPromptSummary(input.prompt),
		context_turns: boundedSelectorContextTurns(input.contextTurns),
		candidates: candidates.map((candidate) => ({ id: candidate.id, condition: boundedCondition(candidate.condition) })),
	};
	const text = canonicalJson(redactJson(payload));
	if (text.length > 12000) throw new Error("Selector prompt too large");
	if (containsUnredactedSensitiveText(text)) throw new Error("Selector prompt contains unredacted sensitive text");
	return text;
}

export function parseSelectorModelOutput(output: unknown, input: { candidateIds: string[]; maxSelected: number; minConfidenceBp: number }): SelectorJudgment[] {
	if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("Invalid selector output");
	const keys = Object.keys(output as Record<string, unknown>).sort();
	if (keys.join(",") !== "judgments,schema_version") throw new Error("Unsupported selector output keys");
	const obj = output as { schema_version?: unknown; judgments?: unknown };
	if (obj.schema_version !== 3) throw new Error("Unsupported selector schema version");
	if (!Array.isArray(obj.judgments)) throw new Error("Invalid selector judgment list");
	const candidateIds = input.candidateIds.map(String);
	const allowed = new Set(candidateIds);
	if (allowed.size !== candidateIds.length || obj.judgments.length !== candidateIds.length) throw new Error("Incomplete selector judgment coverage");
	const seen = new Set<string>();
	const selected: SelectorJudgment[] = [];
	const minimum = Math.max(0, Math.min(10000, Math.trunc(input.minConfidenceBp)));
	for (const item of obj.judgments) {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid selector judgment");
		const itemKeys = Object.keys(item as Record<string, unknown>).sort();
		if (itemKeys.join(",") !== "applicable,confidence_bp,id,reason") throw new Error("Unsupported selector judgment keys");
		const id = String((item as any).id || "");
		const applicable = (item as any).applicable;
		const confidence = Number((item as any).confidence_bp);
		const reason = String((item as any).reason || "");
		if (!allowed.has(id)) throw new Error("Unknown selector habit id");
		if (seen.has(id)) throw new Error("Duplicate selector habit id");
		if (typeof applicable !== "boolean") throw new Error("Invalid selector applicability");
		if (!Number.isInteger(confidence) || confidence < minimum || confidence > 10000) throw new Error("Selector confidence below threshold");
		if (!SELECTOR_JUDGMENT_REASONS.has(reason)) throw new Error("Invalid selector reason");
		if (applicable !== (reason === "current_applicability")) throw new Error("Inconsistent selector judgment");
		seen.add(id);
		if (applicable) selected.push({ id, confidence_bp: confidence });
	}
	if (seen.size !== allowed.size) throw new Error("Incomplete selector judgment coverage");
	const max = Math.max(0, Math.min(3, Math.trunc(input.maxSelected)));
	if (selected.length > max) throw new Error("Too many selector selections");
	return selected;
}

export function buildInjectionMessage(candidates: SelectorCandidate[], selected: Array<{ id: string; confidence_bp?: number }>): string {
	const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
	const lines = ["Agent Experience approved habit guidance (bounded; not policy/law):"];
	for (const item of selected.slice(0, 3)) {
		const candidate = byId.get(item.id);
		if (!candidate) continue;
		lines.push(`- When: ${candidate.condition}`);
		lines.push(`  Do: ${candidate.behavior}`);
	}
	const text = lines.join("\n").slice(0, 2000);
	if (containsUnredactedSensitiveText(text)) throw new Error("Injected selector guidance contains sensitive text");
	return text;
}

async function withAbortTimeout<T>(ms: number, parent: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const abortFromParent = () => controller.abort(parent?.reason instanceof Error ? parent.reason : new Error("selector_cancelled"));
	if (parent?.aborted) abortFromParent();
	else parent?.addEventListener("abort", abortFromParent, { once: true });
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			const error = new Error("selector_timeout");
			try { controller.abort(error); } catch { controller.abort(); }
			reject(error);
		}, Math.max(1, ms));
	});
	try {
		if (controller.signal.aborted) throw controller.signal.reason || new Error("selector_cancelled");
		return await Promise.race([fn(controller.signal), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
		parent?.removeEventListener("abort", abortFromParent);
	}
}

function noInjection(reason: string, extra: Record<string, unknown> = {}) {
	return { injected: false, reason, message: undefined, ...extra };
}

function revalidateSelectedCandidates(db: any, input: {
	userId: string;
	selected: SelectorJudgment[];
	retrieved: RetrievedSelectorCandidate[];
	lawHash: string;
	minConfidenceBp: number;
	stalenessMax: number;
}): SelectorCandidate[] {
	if (!input.selected.length) return [];
	const userId = normalizeUserId(input.userId);
	const expected = new Map(input.retrieved.map((item) => [item.candidate.id, item]));
	const ids = input.selected.map((item) => item.id);
	const placeholders = ids.map(() => "?").join(",");
	const rows = db.prepare(`SELECT * FROM habits WHERE user_id = ? AND id IN (${placeholders}) ORDER BY id`).all(userId, ...ids);
	if (rows.length !== ids.length) throw new Error("selector_snapshot_changed");
	const fresh = new Map<string, SelectorCandidate>();
	for (const row of rows) {
		assertValidHabitStorageRow(row);
		const prior = expected.get(row.id);
		if (!prior || row.user_id !== userId || row.status !== "active" || row.checksum !== prior.candidate.checksum) throw new Error("selector_snapshot_changed");
		const candidate = selectorCandidateFromRow(row);
		if (candidate.law_hash !== input.lawHash || candidate.confidence_bp < input.minConfidenceBp || candidate.staleness > input.stalenessMax) throw new Error("selector_snapshot_changed");
		if (selectorConditionIdentityChecksum(candidate.condition) !== prior.conditionIdentity) throw new Error("selector_snapshot_changed");
		fresh.set(candidate.id, candidate);
	}
	return ids.map((id) => fresh.get(id)!).filter(Boolean);
}

export async function runSelectorRuntime(db: any, input: {
	userId: string;
	prompt: string;
	contextTurns?: SteeringContextTurn[];
	config: AgentExperienceConfig;
	law: LawSnapshot;
	now: string;
	adapter?: SelectorModelAdapter;
	embeddingAdapter?: EmbeddingAdapter;
	signal?: AbortSignal;
}) {
	const userId = normalizeUserId(input.userId);
	const config = input.config;
	const hash = promptHash(input.prompt);
	if (!config.enabled || !config.selector_enabled) return noInjection("selector_disabled");
	if (!input.embeddingAdapter) return noInjection("selector_vectors_unavailable");
	let contextTurns: SteeringContextTurn[] = [];
	try {
		contextTurns = boundedSelectorContextTurns(input.contextTurns);
	} catch {
		// Context is optional reference-resolution data. Invalid or sensitive context
		// degrades to the unchanged current-message-only selector path.
		contextTurns = [];
	}
	const contextualPrompt = buildContextualRetrievalPrompt(input.prompt, contextTurns);
	const selectorMode = contextTurns.length ? "vector_judge_ctx" : "vector_judge";
	const started = Date.now();
	let promptVectors: Awaited<ReturnType<typeof embedSelectorPromptQueries>>;
	try {
		promptVectors = await embedSelectorPromptQueries({ prompt: input.prompt, contextualPrompt, embeddingAdapter: input.embeddingAdapter, signal: input.signal });
	} catch (error: any) {
		return noInjection(input.signal?.aborted ? "selector_cancelled" : "selector_vectors_unavailable");
	}
	let law: LawSnapshot;
	try {
		law = revalidateLawSnapshotSync(input.law);
	} catch {
		return noInjection("selector_law_unavailable");
	}
	let allActive: SelectorCandidate[];
	try {
		allActive = selectActiveSelectorSnapshot(db, { userId });
	} catch {
		return noInjection("selector_habit_integrity_failed");
	}
	const lawFresh = allActive.filter((candidate) => candidate.law_hash === law.hash);
	const eligible = filterEligibleSelectorCandidates(lawFresh, { minConfidenceBp: config.selector_min_confidence_bp, stalenessMax: config.selector_staleness_max });
	if (!eligible.length) return noInjection(allActive.length ? "no_fresh_active_candidates" : "no_active_candidates");
	let retrieved: RetrievedSelectorCandidate[];
	try {
		const conditionVectors = readSelectorConditionVectors(db, { userId, candidates: eligible, embeddingAdapter: input.embeddingAdapter });
		const primary = retrieveSelectorCandidates({ candidates: eligible, conditionVectors, promptVector: promptVectors.currentVector });
		const secondary = promptVectors.contextVector
			? retrieveSelectorCandidates({ candidates: eligible, conditionVectors, promptVector: promptVectors.contextVector })
			: undefined;
		retrieved = unionRetrievedSelectorCandidates({ primary, secondary });
	} catch {
		return noInjection("selector_vectors_unavailable");
	}
	if (!retrieved.length) return noInjection("no_vector_candidates");
	if (!input.adapter) return noInjection("selector_unavailable");
	const retrievedCandidates = retrieved.map((item) => item.candidate);
	let raw: unknown;
	try {
		raw = await withAbortTimeout(config.selector_timeout_ms, input.signal, (signal) => input.adapter!.select({
			prompt: buildSelectorPrompt(retrievedCandidates, { prompt: input.prompt, contextTurns, maxHabits: config.selector_max_habits }),
			candidateIds: retrievedCandidates.map((candidate) => candidate.id),
			timeoutMs: config.selector_timeout_ms,
			model: config.selector_model,
			signal,
		}));
	} catch (error: any) {
		const reason = String(error?.message || "selector_unavailable");
		return noInjection(/^selector_[a-z_]+$/.test(reason) ? reason : "selector_unavailable");
	}
	let selected: SelectorJudgment[];
	try {
		selected = parseSelectorModelOutput(raw, { candidateIds: retrievedCandidates.map((candidate) => candidate.id), maxSelected: config.selector_max_habits, minConfidenceBp: config.selector_min_confidence_bp });
	} catch {
		return noInjection("invalid_selector_output");
	}
	if (!selected.length) return noInjection("empty_selection");
	let selectedCandidates: SelectorCandidate[];
	try {
		selectedCandidates = revalidateSelectedCandidates(db, { userId, selected, retrieved, lawHash: law.hash, minConfidenceBp: config.selector_min_confidence_bp, stalenessMax: config.selector_staleness_max });
	} catch {
		return noInjection("selector_snapshot_changed");
	}
	const message = buildInjectionMessage(selectedCandidates, selected);
	const modelLabel = config.selector_model;
	db.exec("BEGIN IMMEDIATE");
	try {
		const selectedIds = new Set(selected.map((entry) => entry.id));
		for (const candidate of selectedCandidates) {
			insertSelectorHitLog(db, { userId, habitId: candidate.id, action: "inject", selected: true, reason: "selected", confidenceBp: candidate.confidence_bp, promptHash: hash, latencyMs: Date.now() - started, data: { selected_count: selected.length, model: modelLabel, mode: selectorMode }, createdAt: input.now });
		}
		for (const item of retrieved) {
			if (selectedIds.has(item.candidate.id)) continue;
			insertSelectorHitLog(db, { userId, habitId: item.candidate.id, action: "skip", selected: false, reason: "not_selected", confidenceBp: item.candidate.confidence_bp, promptHash: hash, latencyMs: Date.now() - started, data: { selected_count: selected.length, model: modelLabel, mode: selectorMode }, createdAt: input.now });
		}
		db.exec("COMMIT");
	} catch {
		try { db.exec("ROLLBACK"); } catch {}
		return noInjection("hit_log_write_failed");
	}
	return { injected: true, reason: "selected", message, selected, candidates: selectedCandidates, latency_ms: Date.now() - started, mode: selectorMode, model: modelLabel };
}

export async function measureSelectorLatency(input: { adapter: SelectorModelAdapter; prompt: string; contextTurns?: SteeringContextTurn[]; candidates: SelectorCandidate[]; iterations: number; timeoutMs: number; model: string }) {
	const samples: number[] = [];
	for (let index = 0; index < input.iterations; index += 1) {
		const started = Date.now();
		await withAbortTimeout(input.timeoutMs, undefined, (signal) => input.adapter.select({ prompt: buildSelectorPrompt(input.candidates, { prompt: input.prompt, contextTurns: input.contextTurns, maxHabits: 3 }), candidateIds: input.candidates.map((candidate) => candidate.id), timeoutMs: input.timeoutMs, model: input.model, signal }));
		samples.push(Date.now() - started);
	}
	const sorted = samples.slice().sort((a, b) => a - b);
	const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
	return { samples, p95_ms: p95, compatible_with_1500ms: p95 <= 1500, compatible_with_configured_threshold: p95 <= input.timeoutMs };
}

function normalizedApprovalIdentity(row: any) {
	return { candidate_id: row.id, condition: String(row.condition ?? "").trim().replace(/\s+/g, " ").toLowerCase(), behavior: String(row.behavior ?? "").trim().replace(/\s+/g, " ").toLowerCase(), polarity: Number(row.polarity) };
}

function insertPromotionAudit(db: any, input: { userId: string; rowId: string; action: string; before: any; after: any; data: any; now: string }) {
	const beforeJson = boundedJson(input.before);
	const afterJson = boundedJson(input.after);
	const dataJson = boundedJson(input.data);
	const base = { user_id: input.userId, target_kind: "habit", target_id: input.rowId, action: input.action, before_json: beforeJson, after_json: afterJson, data_json: dataJson, created_at: input.now };
	const checksum = checksumJson({ table: "experience_review_audit", row: base });
	const id = stableId("review-audit", { ...base, checksum });
	db.prepare("INSERT OR IGNORE INTO experience_review_audit (id, user_id, target_kind, target_id, action, before_json, after_json, data_json, checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.run(id, input.userId, "habit", input.rowId, input.action, beforeJson, afterJson, dataJson, checksum, input.now);
	return id;
}

function updatePromotedHabit(db: any, input: { userId: string; before: any; data: any; status: string; now: string }) {
	const updated = buildTypedStorageRow("habits", { id: input.before.id, userId: input.userId, data: { ...input.data, status: input.status }, createdAt: input.before.created_at, updatedAt: input.now });
	const changes = db.prepare("UPDATE habits SET record_kind=?, schema_version=?, status=?, habit_id=?, condition=?, behavior=?, polarity=?, confidence_bp=?, activation=?, staleness=?, data_json=?, checksum=?, updated_at=? WHERE user_id=? AND id=? AND status=? AND checksum=?")
		.run(updated.record_kind, updated.schema_version, updated.status, updated.habit_id, updated.condition, updated.behavior, updated.polarity, updated.confidence_bp, updated.activation, updated.staleness, updated.data_json, updated.checksum, updated.updated_at, input.userId, input.before.id, input.before.status, input.before.checksum).changes;
	if (changes !== 1) throw new Error("Approved habit recheck raced; retry");
	return db.prepare("SELECT * FROM habits WHERE user_id = ? AND id = ?").get(input.userId, input.before.id);
}

export async function promoteApprovedPendingCandidates(db: any, input: { userId: string; law: LawSnapshot; now: string; semantic: { policy: Partial<SemanticDedupePolicy>; provider?: EmbeddingAdapter; signal?: AbortSignal }; candidateIdsForTest?: string[] }) {
	if (!input.semantic?.policy) throw new Error("Background promotion requires an explicit semantic dedupe policy");
	const userId = normalizeUserId(input.userId);
	const waitingStatuses = new Set(["approved_pending_eligibility", "approved_pending_conflict", "approved_pending_law_blocked", "kept_separate"]);
	const testIds = input.candidateIdsForTest ? new Set(input.candidateIdsForTest) : undefined;
	const rows = db.prepare("SELECT * FROM habits WHERE user_id = ? AND status IN ('candidate','suppressed_by_law') ORDER BY id").all(userId)
		.filter((row: any) => waitingStatuses.has(parseJson(row.data_json).review_status))
		.filter((row: any) => !testIds || testIds.has(row.id));
	const promoted: string[] = [];
	const blocked: Array<{ id: string; reason: string }> = [];
	for (const initial of rows) {
		const initialData = parseJson(initial.data_json);
		const currentIdentity = normalizedApprovalIdentity(initial);
		const approvedIdentity = initialData.approved_identity ? { candidate_id: initialData.approved_identity.candidate_id, condition: initialData.approved_identity.condition, behavior: initialData.approved_identity.behavior, polarity: Number(initialData.approved_identity.polarity) } : currentIdentity;
		if (canonicalJson(approvedIdentity) !== canonicalJson(currentIdentity)) {
			db.exec("BEGIN IMMEDIATE");
			try {
				const before = db.prepare("SELECT * FROM habits WHERE user_id = ? AND id = ?").get(userId, initial.id);
				if (!before || before.checksum !== initial.checksum) throw new Error("Approved habit identity changed concurrently");
				const after = updatePromotedHabit(db, { userId, before, status: "candidate", now: input.now, data: { ...parseJson(before.data_json), review_status: "candidate_reapproval_required", active: false, injectable: false, approved_identity: null, approval_invalidated: { reason: "material_identity_change", at: input.now } } });
				insertPromotionAudit(db, { userId, rowId: before.id, action: "promotion_requires_reapproval", before, after, data: { approved_identity: approvedIdentity, current_identity: currentIdentity }, now: input.now });
				db.exec("COMMIT");
				blocked.push({ id: initial.id, reason: "identity_changed" });
				continue;
			} catch (error) {
				try { db.exec("ROLLBACK"); } catch {}
				throw error;
			}
		}
		const outcome = await runAtomicSemanticActivation(db, {
			userId,
			targetHabitId: initial.id,
			expectedStatus: initial.status,
			expectedChecksum: initial.checksum,
			policy: input.semantic.policy,
			provider: input.semantic.provider,
			now: input.now,
			signal: input.semantic.signal,
			targetKind: "promote_pending_candidate",
			transition: (target, semantic) => {
				const before = db.prepare("SELECT * FROM habits WHERE user_id = ? AND id = ?").get(userId, target.id);
				const data = parseJson(before.data_json);
				const identity = data.approved_identity ? { candidate_id: data.approved_identity.candidate_id, condition: data.approved_identity.condition, behavior: data.approved_identity.behavior, polarity: Number(data.approved_identity.polarity) } : normalizedApprovalIdentity(before);
				if (canonicalJson(identity) !== canonicalJson(normalizedApprovalIdentity(before))) throw new Error("Approved habit wording changed; explicit reapproval required");
				const eligibility = activationEligibilityFromHabit(before);
				const lawSnapshot = revalidateLawSnapshotSync(input.law);
				const law = checkHabitLaw({ condition: before.condition, behavior: before.behavior, law: lawSnapshot });
				const conflict = checkHabitConflict(db, { userId, habitId: before.id, condition: before.condition, behavior: before.behavior, polarity: Number(before.polarity) });
				const baseData = { ...data, condition: before.condition, behavior: before.behavior, polarity: before.polarity, confidence_bp: before.confidence_bp, record_kind: before.record_kind, schema_version: before.schema_version, approved_identity: { ...identity, approved_at: data.approved_identity?.approved_at || input.now }, law_hash: lawSnapshot.hash, promotion_decision: { eligibility, law, conflict, semantic }, active: false, injectable: false };
				if (!eligibility.eligible || !law.pass || !conflict.pass) {
					const reason = !eligibility.eligible ? "evidence" : !law.pass ? "law" : "conflict";
					const status = reason === "law" ? "suppressed_by_law" : "candidate";
					const reviewStatus = reason === "law" ? "approved_pending_law_blocked" : reason === "conflict" ? "approved_pending_conflict" : "approved_pending_eligibility";
					const after = updatePromotedHabit(db, { userId, before, status, now: input.now, data: { ...baseData, review_status: reviewStatus, approved_pending_reason: reason } });
					const auditId = insertPromotionAudit(db, { userId, rowId: before.id, action: "promotion_blocked", before, after, data: { eligibility, law, conflict, semantic, reason }, now: input.now });
					return { promoted: false, id: before.id, reason, audit_id: auditId };
				}
				const after = updatePromotedHabit(db, { userId, before, status: "active", now: input.now, data: { ...baseData, review_status: "promoted_active", active: true, promoted_at: input.now } });
				const auditId = insertPromotionAudit(db, { userId, rowId: before.id, action: "promote_approved_candidate", before, after, data: { eligibility, law, conflict, semantic, approved_identity: identity }, now: input.now });
				return { promoted: true, id: before.id, audit_id: auditId };
			},
			onBlocked: (target, semantic) => {
				const before = db.prepare("SELECT * FROM habits WHERE user_id = ? AND id = ?").get(userId, target.id);
				const duplicate = semantic.reason === "semantic_duplicate";
				const data = parseJson(before.data_json);
				const after = updatePromotedHabit(db, { userId, before, status: before.status, now: input.now, data: { ...data, review_status: duplicate ? "duplicate_resolution" : "approved_pending_eligibility", active: false, injectable: false, approved_identity: data.approved_identity || { ...normalizedApprovalIdentity(before), approved_at: input.now }, approved_pending_reason: semantic.reason, promotion_decision: { semantic } } });
				const reason = duplicate ? "semantic_duplicate" : "semantic_unavailable";
				const auditId = insertPromotionAudit(db, { userId, rowId: before.id, action: "promotion_semantic_blocked", before, after, data: { semantic, reason }, now: input.now });
				return { promoted: false, id: before.id, reason, audit_id: auditId };
			},
		});
		if (outcome.result?.promoted) promoted.push(initial.id);
		else blocked.push({ id: initial.id, reason: outcome.result?.reason || outcome.semantic.reason });
	}
	return { user_id: userId, checked: rows.length, promoted, blocked };
}
