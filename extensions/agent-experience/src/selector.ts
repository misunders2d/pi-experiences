import { canonicalJson, checksumJson, sha256Hex } from "./storage/checksum.ts";
import { normalizeUserId } from "./storage/private-root.ts";
import { containsUnredactedSensitiveText, redactJson, redactText } from "./storage/redaction.ts";
import { buildTypedStorageRow } from "./storage/sqlite.ts";
import { activationEligibilityFromHabit, checkHabitConflict, checkHabitLaw, type LawSnapshot } from "./review.ts";
import type { AgentExperienceConfig } from "./config.ts";

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
	score?: number;
}

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

function normalizeText(value: unknown): string {
	return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function tokens(value: unknown): Set<string> {
	return new Set(normalizeText(value).split(" ").filter((token) => token.length >= 3).slice(0, 80));
}

export function lexicalOverlapScore(prompt: string, candidate: SelectorCandidate): number {
	const promptTokens = tokens(prompt);
	const habitTokens = tokens(`${candidate.condition} ${candidate.behavior}`);
	let overlap = 0;
	for (const token of habitTokens) if (promptTokens.has(token)) overlap += 1;
	return overlap;
}

function overlapScore(prompt: string, candidate: SelectorCandidate): number {
	const overlap = lexicalOverlapScore(prompt, candidate);
	const confidence = candidate.confidence_bp / 10000;
	const activation = Number.isFinite(candidate.activation) ? candidate.activation : 0;
	const stalenessPenalty = Math.max(0, Math.min(1, candidate.staleness || 0));
	return overlap * 1000 + confidence * 100 + activation * 10 - stalenessPenalty * 100;
}

function dayBounds(iso: string): { start: string; end: string } {
	const day = new Date(iso).toISOString().slice(0, 10);
	const start = `${day}T00:00:00.000Z`;
	const end = new Date(Date.parse(start) + 24 * 60 * 60 * 1000).toISOString();
	return { start, end };
}

function promptHash(_prompt: string): string {
	// Do not persist hashes or derivatives of prompt text: even deterministic hashes of
	// redacted prompts are linkable/dictionary-checkable user-content derivatives.
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

export function countDailySelectorInjections(db: any, input: { userId: string; now: string }): number {
	const userId = normalizeUserId(input.userId);
	const { start, end } = dayBounds(input.now);
	const rows = db.prepare("SELECT * FROM selector_hit_log WHERE user_id = ? AND action = 'inject' AND selected = 1 AND created_at >= ? AND created_at < ? ORDER BY created_at, id").all(userId, start, end);
	return rows.filter(isValidSelectorHitLog).length;
}

export function selectActiveSelectorSnapshot(db: any, input: { userId: string }): SelectorCandidate[] {
	const userId = normalizeUserId(input.userId);
	return db.prepare("SELECT id, user_id, status, condition, behavior, polarity, confidence_bp, activation, staleness, checksum, data_json FROM habits WHERE user_id = ? AND status = 'active' ORDER BY id").all(userId)
		.map((row: any) => {
			const data = parseJson(row.data_json);
			return redactJson({ id: row.id, user_id: row.user_id, condition: row.condition || "", behavior: row.behavior || "", polarity: Number(row.polarity), confidence_bp: Number(row.confidence_bp), activation: Number(row.activation), staleness: Number(row.staleness), checksum: row.checksum, law_hash: typeof data.law_hash === "string" ? data.law_hash : undefined }) as SelectorCandidate;
		});
}

export function preNarrowSelectorCandidates(candidates: SelectorCandidate[], input: { prompt: string; limit?: number; minConfidenceBp?: number; stalenessMax?: number }): SelectorCandidate[] {
	const limit = Math.max(0, Math.min(20, Math.trunc(input.limit ?? 20)));
	const minConfidence = Math.max(0, Math.min(10000, Math.trunc(input.minConfidenceBp ?? 0)));
	const stalenessMax = Number.isFinite(input.stalenessMax) ? Number(input.stalenessMax) : Number.POSITIVE_INFINITY;
	return candidates
		.filter((candidate) => candidate.confidence_bp >= minConfidence && candidate.staleness <= stalenessMax)
		.map((candidate) => ({ ...candidate, score: overlapScore(input.prompt, candidate) }))
		.sort((a, b) => (b.score! - a.score!) || b.confidence_bp - a.confidence_bp || a.id.localeCompare(b.id))
		.slice(0, limit);
}

export function selectInstantSelectorCandidates(candidates: SelectorCandidate[], input: { prompt: string; maxHabits: number; minOverlapScore: number; minConfidenceBp: number }): Array<{ id: string; confidence_bp: number }> {
	const max = Math.max(0, Math.min(3, Math.trunc(input.maxHabits)));
	const minOverlap = Math.max(1, Math.trunc(input.minOverlapScore));
	const minConfidence = Math.max(0, Math.min(10000, Math.trunc(input.minConfidenceBp)));
	return candidates
		.map((candidate) => ({ candidate, overlap: lexicalOverlapScore(input.prompt, candidate) }))
		.filter((item) => item.overlap >= minOverlap && item.candidate.confidence_bp >= minConfidence)
		.sort((a, b) => (b.overlap - a.overlap) || b.candidate.confidence_bp - a.candidate.confidence_bp || b.candidate.activation - a.candidate.activation || a.candidate.id.localeCompare(b.candidate.id))
		.slice(0, max)
		.map((item) => ({ id: item.candidate.id, confidence_bp: item.candidate.confidence_bp }));
}

export function buildSelectorPrompt(candidates: SelectorCandidate[], input: { prompt: string; maxHabits: number }): string {
	const safePromptSummary = normalizeText(redactText(input.prompt)).slice(0, 500);
	const payload = redactJson({ schema_version: 1, task: "select_agent_experience_habits", max_selected: Math.max(0, Math.min(3, Math.trunc(input.maxHabits))), user_prompt_summary: safePromptSummary, candidates: candidates.map((candidate) => ({ id: candidate.id, condition: candidate.condition, behavior: candidate.behavior, confidence_bp: candidate.confidence_bp, staleness: candidate.staleness })) });
	const text = canonicalJson(payload);
	if (text.length > 12000) throw new Error("Selector prompt too large");
	if (containsUnredactedSensitiveText(text)) throw new Error("Selector prompt contains unredacted sensitive text");
	return text;
}

export function parseSelectorModelOutput(output: unknown, input: { candidateIds: string[]; maxSelected: number; minConfidenceBp: number }) {
	if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("Invalid selector output");
	const keys = Object.keys(output as Record<string, unknown>).sort();
	if (keys.join(",") !== "schema_version,selected") throw new Error("Unsupported selector output keys");
	const obj = output as { schema_version?: unknown; selected?: unknown };
	if (obj.schema_version !== 1) throw new Error("Unsupported selector schema version");
	if (!Array.isArray(obj.selected)) throw new Error("Invalid selector selected list");
	const allowed = new Set(input.candidateIds);
	const seen = new Set<string>();
	const max = Math.max(0, Math.min(3, Math.trunc(input.maxSelected)));
	if (obj.selected.length > max) throw new Error("Too many selector selections");
	return obj.selected.map((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid selector selection");
		const itemKeys = Object.keys(item as Record<string, unknown>).sort();
		if (itemKeys.join(",") !== "confidence_bp,id") throw new Error("Unsupported selector selection keys");
		const id = String((item as any).id || "");
		const confidence = Number((item as any).confidence_bp);
		if (!allowed.has(id)) throw new Error("Unknown selector habit id");
		if (seen.has(id)) throw new Error("Duplicate selector habit id");
		if (!Number.isInteger(confidence) || confidence < 0 || confidence > 10000) throw new Error("Invalid selector confidence");
		if (confidence < input.minConfidenceBp) throw new Error("Selector confidence below threshold");
		seen.add(id);
		return { id, confidence_bp: confidence };
	});
}

export function buildInjectionMessage(candidates: SelectorCandidate[], selected: Array<{ id: string; confidence_bp: number }>): string {
	const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
	const lines = ["Agent Experience generated guidance (bounded; not policy/law):"];
	for (const item of selected.slice(0, 3)) {
		const candidate = byId.get(item.id);
		if (!candidate) continue;
		lines.push(`- When ${candidate.condition}: ${candidate.behavior} (confidence_bp=${item.confidence_bp})`);
	}
	const text = lines.join("\n").slice(0, 2000);
	if (containsUnredactedSensitiveText(text)) throw new Error("Injected selector guidance contains sensitive text");
	return text;
}

async function withAbortTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			try { controller.abort(new Error("selector_timeout")); } catch { controller.abort(); }
			reject(new Error("selector_timeout"));
		}, Math.max(1, ms));
	});
	try {
		return await Promise.race([fn(controller.signal), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function noInjection(reason: string, extra: Record<string, unknown> = {}) {
	return { injected: false, reason, message: undefined, ...extra };
}

export async function runSelectorRuntime(db: any, input: { userId: string; prompt: string; config: AgentExperienceConfig; law: LawSnapshot; now: string; adapter?: SelectorModelAdapter }) {
	const userId = normalizeUserId(input.userId);
	const config = input.config;
	const now = input.now;
	const hash = promptHash(input.prompt);
	if (!config.enabled || !config.selector_enabled) return noInjection("selector_disabled");
	const dailyBudget = Math.max(0, Math.trunc(config.selector_daily_budget));
	if (countDailySelectorInjections(db, { userId, now }) >= dailyBudget) return noInjection("daily_budget_exceeded");
	const allActive = selectActiveSelectorSnapshot(db, { userId });
	const lawFresh = allActive.filter((candidate) => candidate.law_hash === input.law.hash);
	const candidates = preNarrowSelectorCandidates(lawFresh, { prompt: input.prompt, limit: 20, minConfidenceBp: config.selector_min_confidence_bp, stalenessMax: config.selector_staleness_max });
	if (!candidates.length) return noInjection(allActive.length ? "no_fresh_active_candidates" : "no_active_candidates");
	const mode = config.selector_mode === "smart" ? "smart" : "instant";
	const started = Date.now();
	let selected: Array<{ id: string; confidence_bp: number }>;
	if (mode === "instant") {
		selected = selectInstantSelectorCandidates(candidates, { prompt: input.prompt, maxHabits: config.selector_max_habits, minOverlapScore: config.selector_min_overlap_score, minConfidenceBp: config.selector_min_confidence_bp });
	} else {
		if (!input.adapter) return noInjection("selector_unavailable", { candidates });
		let raw: unknown;
		try {
			raw = await withAbortTimeout(config.selector_timeout_ms, (signal) => input.adapter!.select({ prompt: buildSelectorPrompt(candidates, { prompt: input.prompt, maxHabits: config.selector_max_habits }), candidateIds: candidates.map((candidate) => candidate.id), timeoutMs: config.selector_timeout_ms, model: config.selector_model, signal }));
		} catch (error: any) {
			return noInjection(String(error?.message || "selector_unavailable"));
		}
		try {
			selected = parseSelectorModelOutput(raw, { candidateIds: candidates.map((candidate) => candidate.id), maxSelected: config.selector_max_habits, minConfidenceBp: config.selector_min_confidence_bp });
		} catch {
			return noInjection("invalid_selector_output");
		}
	}
	if (!selected.length) return noInjection("empty_selection");
	const message = buildInjectionMessage(candidates, selected);
	const modelLabel = mode === "instant" ? "lexical" : config.selector_model;
	db.exec("BEGIN IMMEDIATE");
	try {
		const selectedIds = new Set(selected.map((entry) => entry.id));
		for (const item of selected) {
			const candidate = candidates.find((entry) => entry.id === item.id);
			insertSelectorHitLog(db, { userId, habitId: item.id, action: "inject", selected: true, reason: "selected", confidenceBp: item.confidence_bp, promptHash: hash, latencyMs: Date.now() - started, data: { selected_count: selected.length, model: modelLabel, mode, staleness: candidate?.staleness ?? 0 }, createdAt: now });
		}
		for (const candidate of candidates) {
			if (selectedIds.has(candidate.id)) continue;
			insertSelectorHitLog(db, { userId, habitId: candidate.id, action: "skip", selected: false, reason: "not_selected", promptHash: hash, latencyMs: Date.now() - started, data: { selected_count: selected.length, model: modelLabel, mode, staleness: candidate.staleness }, createdAt: now });
		}
		db.exec("COMMIT");
	} catch (error) {
		try { db.exec("ROLLBACK"); } catch {}
		return noInjection("hit_log_write_failed");
	}
	return { injected: true, reason: "selected", message, selected, candidates, latency_ms: Date.now() - started, mode, model: modelLabel };
}

export async function measureSelectorLatency(input: { adapter: SelectorModelAdapter; prompt: string; candidates: SelectorCandidate[]; iterations: number; timeoutMs: number; model: string }) {
	const samples: number[] = [];
	for (let index = 0; index < input.iterations; index += 1) {
		const started = Date.now();
		await withAbortTimeout(input.timeoutMs, (signal) => input.adapter.select({ prompt: buildSelectorPrompt(input.candidates, { prompt: input.prompt, maxHabits: 3 }), candidateIds: input.candidates.map((candidate) => candidate.id), timeoutMs: input.timeoutMs, model: input.model, signal }));
		samples.push(Date.now() - started);
	}
	const sorted = samples.slice().sort((a, b) => a - b);
	const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
	return { samples, p95_ms: p95, compatible_with_1500ms: p95 <= 1500, compatible_with_configured_threshold: p95 <= input.timeoutMs };
}

export function promoteApprovedPendingCandidates(db: any, input: { userId: string; law: LawSnapshot; now: string }) {
	const userId = normalizeUserId(input.userId);
	let result: any;
	db.exec("BEGIN IMMEDIATE");
	try {
		const rows = db.prepare("SELECT * FROM habits WHERE user_id = ? AND status = 'candidate' ORDER BY id").all(userId).filter((row: any) => parseJson(row.data_json).review_status === "approved_pending_eligibility");
		const promoted: string[] = [];
		const blocked: Array<{ id: string; reason: string }> = [];
		for (const row of rows) {
			const eligibility = activationEligibilityFromHabit(row);
			if (!eligibility.eligible) continue;
			const law = checkHabitLaw({ condition: row.condition, behavior: row.behavior, law: input.law });
			const conflict = checkHabitConflict(db, { userId, habitId: row.id, condition: row.condition, behavior: row.behavior, polarity: Number(row.polarity) });
			const data = { ...parseJson(row.data_json), condition: row.condition, behavior: row.behavior, polarity: row.polarity, confidence_bp: row.confidence_bp, record_kind: row.record_kind, schema_version: row.schema_version, law_hash: input.law.hash, promotion_decision: { eligibility, law, conflict } };
			if (law.pass && conflict.pass) {
				const updated = buildTypedStorageRow("habits", { id: row.id, userId, data: { ...data, status: "active", review_status: "promoted_active", active: true, injectable: false, promoted_at: input.now }, createdAt: row.created_at, updatedAt: input.now });
				const changes = db.prepare("UPDATE habits SET record_kind=?, schema_version=?, status=?, habit_id=?, condition=?, behavior=?, polarity=?, confidence_bp=?, activation=?, staleness=?, data_json=?, checksum=?, updated_at=? WHERE user_id=? AND id=? AND status='candidate' AND checksum=?")
					.run(updated.record_kind, updated.schema_version, updated.status, updated.habit_id, updated.condition, updated.behavior, updated.polarity, updated.confidence_bp, updated.activation, updated.staleness, updated.data_json, updated.checksum, updated.updated_at, userId, row.id, row.checksum).changes;
				if (changes !== 1) throw new Error("Promotion update failed");
				promoted.push(row.id);
				db.prepare("INSERT INTO experience_review_audit (id, user_id, target_kind, target_id, action, before_json, after_json, data_json, checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
					.run(stableId("review-audit", { row: row.id, action: "promote_approved_candidate", now: input.now }), userId, "habit", row.id, "promote_approved_candidate", boundedJson(row), boundedJson({ ...row, status: "active", checksum: updated.checksum }), boundedJson({ eligibility, law, conflict }), checksumJson({ table: "experience_review_audit", row: { user_id: userId, target_kind: "habit", target_id: row.id, action: "promote_approved_candidate", before_json: boundedJson(row), after_json: boundedJson({ ...row, status: "active", checksum: updated.checksum }), data_json: boundedJson({ eligibility, law, conflict }), created_at: input.now } }), input.now);
			} else {
				const status = law.pass ? "candidate" : "suppressed_by_law";
				const updated = buildTypedStorageRow("habits", { id: row.id, userId, data: { ...data, status, review_status: law.pass ? "approved_pending_conflict" : "approved_pending_law_blocked", active: false, injectable: false }, createdAt: row.created_at, updatedAt: input.now });
				const changes = db.prepare("UPDATE habits SET record_kind=?, schema_version=?, status=?, habit_id=?, condition=?, behavior=?, polarity=?, confidence_bp=?, activation=?, staleness=?, data_json=?, checksum=?, updated_at=? WHERE user_id=? AND id=? AND status='candidate' AND checksum=?")
					.run(updated.record_kind, updated.schema_version, updated.status, updated.habit_id, updated.condition, updated.behavior, updated.polarity, updated.confidence_bp, updated.activation, updated.staleness, updated.data_json, updated.checksum, updated.updated_at, userId, row.id, row.checksum).changes;
				if (changes !== 1) throw new Error("Promotion block update failed");
				blocked.push({ id: row.id, reason: law.pass ? "conflict" : "law" });
				db.prepare("INSERT INTO experience_review_audit (id, user_id, target_kind, target_id, action, before_json, after_json, data_json, checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
					.run(stableId("review-audit", { row: row.id, action: "promotion_blocked", now: input.now }), userId, "habit", row.id, "promotion_blocked", boundedJson(row), boundedJson({ ...row, status: updated.status, checksum: updated.checksum }), boundedJson({ eligibility, law, conflict }), checksumJson({ table: "experience_review_audit", row: { user_id: userId, target_kind: "habit", target_id: row.id, action: "promotion_blocked", before_json: boundedJson(row), after_json: boundedJson({ ...row, status: updated.status, checksum: updated.checksum }), data_json: boundedJson({ eligibility, law, conflict }), created_at: input.now } }), input.now);
			}
		}
		result = { user_id: userId, checked: rows.length, promoted, blocked };
		db.exec("COMMIT");
	} catch (error) {
		try { db.exec("ROLLBACK"); } catch {}
		throw error;
	}
	return result;
}
