import { lstat, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, checksumJson, sha256Hex } from "./storage/checksum.ts";
import { normalizeUserId, resolvePrivatePath, ensurePrivateRoot } from "./storage/private-root.ts";
import { redactJson, containsUnredactedSensitiveText } from "./storage/redaction.ts";
import { buildTypedStorageRow } from "./storage/sqlite.ts";

export const LAW_CHECKER_VERSION = "agent_experience_law_check_v1";
const REPORT_NAME = "habits-report.md";

function stableId(prefix: string, value: unknown): string {
	return `${prefix}-${sha256Hex(canonicalJson(value)).slice(0, 40)}`;
}

function normalizeText(value: unknown): string {
	return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function parseJson(text: string | null | undefined): any {
	try {
		return JSON.parse(String(text || "{}"));
	} catch {
		return {};
	}
}

function boundedJson(value: unknown, max = 24000): string {
	const redacted = redactJson(value ?? {});
	const text = canonicalJson(redacted);
	if (text.length > max) throw new Error("Review payload too large");
	if (containsUnredactedSensitiveText(text)) throw new Error("Review payload contains unredacted sensitive text");
	return text;
}

function pendingReviewChecksum(row: { user_id: string; kind: string; status: string; payload_json: string }): string {
	return checksumJson({ table: "pending_review", row });
}

function auditChecksum(row: { user_id: string; target_kind: string; target_id: string; action: string; before_json: string; after_json: string; data_json: string; created_at: string }): string {
	return checksumJson({ table: "experience_review_audit", row });
}

function insertReviewAudit(db: any, input: { userId: string; targetKind: string; targetId: string; action: string; before: unknown; after: unknown; data?: unknown; createdAt: string }): { id: string; inserted: boolean } {
	const userId = normalizeUserId(input.userId);
	const beforeJson = boundedJson(input.before ?? null);
	const afterJson = boundedJson(input.after ?? null);
	const dataJson = boundedJson(input.data ?? {});
	const checksum = auditChecksum({ user_id: userId, target_kind: input.targetKind, target_id: input.targetId, action: input.action, before_json: beforeJson, after_json: afterJson, data_json: dataJson, created_at: input.createdAt });
	const id = stableId("review-audit", { user_id: userId, target_kind: input.targetKind, target_id: input.targetId, action: input.action, checksum });
	const existing = db.prepare("SELECT id, checksum FROM experience_review_audit WHERE id = ?").get(id);
	if (existing) {
		if (existing.checksum !== checksum) throw new Error("Review audit stable id collision");
		return { id, inserted: false };
	}
	db.prepare("INSERT INTO experience_review_audit (id, user_id, target_kind, target_id, action, before_json, after_json, data_json, checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.run(id, userId, input.targetKind, input.targetId, input.action, beforeJson, afterJson, dataJson, checksum, input.createdAt);
	return { id, inserted: true };
}

function getHabit(db: any, userId: string, habitId: string): any {
	const row = db.prepare("SELECT * FROM habits WHERE user_id = ? AND id = ?").get(normalizeUserId(userId), habitId);
	if (!row) throw new Error("Habit not found");
	return row;
}

function getPendingReview(db: any, userId: string, id: string): any {
	const row = db.prepare("SELECT * FROM pending_review WHERE user_id = ? AND id = ?").get(normalizeUserId(userId), id);
	if (!row) throw new Error("Pending review not found");
	return row;
}

function updateHabitRow(db: any, input: { userId: string; id: string; expectedStatus: string; expectedChecksum: string; data: Record<string, unknown>; status: string; now: string }) {
	const existing = getHabit(db, input.userId, input.id);
	if (existing.status !== input.expectedStatus || existing.checksum !== input.expectedChecksum) throw new Error("Stale habit state");
	const row = buildTypedStorageRow("habits", { id: input.id, userId: input.userId, data: { ...input.data, status: input.status }, createdAt: existing.created_at, updatedAt: input.now });
	const result = db.prepare("UPDATE habits SET record_kind=?, schema_version=?, status=?, habit_id=?, condition=?, behavior=?, polarity=?, confidence_bp=?, activation=?, staleness=?, data_json=?, checksum=?, updated_at=? WHERE user_id=? AND id=? AND status=? AND checksum=?")
		.run(row.record_kind, row.schema_version, row.status, row.habit_id, row.condition, row.behavior, row.polarity, row.confidence_bp, row.activation, row.staleness, row.data_json, row.checksum, row.updated_at, row.user_id, row.id, input.expectedStatus, input.expectedChecksum);
	if (result.changes !== 1) throw new Error("Habit update failed");
	return row;
}

function transitionPendingReview(db: any, input: { userId: string; id: string; expectedChecksum: string; status: "accepted" | "rejected"; now: string; action: string }) {
	const existing = getPendingReview(db, input.userId, input.id);
	if (existing.status !== "open" || existing.checksum !== input.expectedChecksum) throw new Error("Stale pending review state");
	const checksum = pendingReviewChecksum({ user_id: existing.user_id, kind: existing.kind, status: input.status, payload_json: existing.payload_json });
	const result = db.prepare("UPDATE pending_review SET status = ?, checksum = ?, updated_at = ? WHERE user_id = ? AND id = ? AND status = 'open' AND checksum = ?")
		.run(input.status, checksum, input.now, existing.user_id, existing.id, input.expectedChecksum);
	if (result.changes !== 1) throw new Error("Pending review transition failed");
	const after = { ...existing, status: input.status, checksum, updated_at: input.now };
	insertReviewAudit(db, { userId: input.userId, targetKind: "pending_review", targetId: input.id, action: input.action, before: existing, after, createdAt: input.now });
	return after;
}

function tokenSet(text: string): Set<string> {
	return new Set(normalizeText(text).split(/[^a-z0-9]+/).filter((token) => token.length > 1));
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (!a.size && !b.size) return 1;
	let intersection = 0;
	for (const token of a) if (b.has(token)) intersection++;
	return intersection / (a.size + b.size - intersection);
}

function nearDuplicate(a: any, b: any): boolean {
	const ac = normalizeText(a.condition);
	const bc = normalizeText(b.condition);
	const ab = normalizeText(a.behavior);
	const bb = normalizeText(b.behavior);
	if (!ac || !bc || !ab || !bb) return false;
	if (ac === bc && ab === bb) return true;
	return jaccard(tokenSet(`${ac} ${ab}`), tokenSet(`${bc} ${bb}`)) >= 0.72;
}

export function listPendingReviewItems(db: any, input: { userId: string }) {
	const userId = normalizeUserId(input.userId);
	const pending = db.prepare("SELECT id, user_id, kind, status, payload_json, checksum, created_at, updated_at FROM pending_review WHERE user_id = ? AND status = 'open' ORDER BY created_at, id").all(userId)
		.map((row: any) => ({ type: "pending_review", ...row, payload: parseJson(row.payload_json) }));
	const candidates = db.prepare("SELECT id, user_id, record_kind, status, condition, behavior, polarity, confidence_bp, data_json, checksum, created_at, updated_at FROM habits WHERE user_id = ? AND status = 'candidate' ORDER BY updated_at, id").all(userId)
		.map((row: any) => ({ type: "candidate", ...row, payload: parseJson(row.data_json) }))
		.filter((row: any) => row.payload?.review_status !== "approved_pending_eligibility");
	const items = [...pending, ...candidates];
	const groups: Record<string, string[]> = {};
	let groupNumber = 1;
	for (let i = 0; i < candidates.length; i++) {
		const ids = [candidates[i].id];
		for (let j = i + 1; j < candidates.length; j++) if (nearDuplicate(candidates[i], candidates[j])) ids.push(candidates[j].id);
		if (ids.length > 1) {
			const groupId = `near-duplicate-${groupNumber++}`;
			groups[groupId] = ids;
		}
	}
	return { user_id: userId, items, near_duplicate_groups: groups };
}

export function showPendingReviewItem(db: any, input: { userId: string; id: string }) {
	const list = listPendingReviewItems(db, input);
	const item = list.items.find((candidate: any) => candidate.id === input.id);
	if (!item) throw new Error("Review item not found");
	return { user_id: list.user_id, item, near_duplicate_groups: Object.fromEntries(Object.entries(list.near_duplicate_groups).filter(([, ids]) => ids.includes(input.id))) };
}

export function diffPendingReviewItems(db: any, input: { userId: string }) {
	const list = listPendingReviewItems(db, input);
	return {
		user_id: list.user_id,
		near_duplicate_groups: list.near_duplicate_groups,
		diff: Object.entries(list.near_duplicate_groups).map(([group_id, ids]) => ({ group_id, ids, note: "lexical near-duplicate; human review required; no automatic merge" })),
	};
}

function uniqueRefs(data: any): string[] {
	const refs = Array.isArray(data?.source_refs) ? data.source_refs : [];
	return [...new Set(refs.map((ref: any) => canonicalJson({ file_generation: ref.file_generation, seq: ref.seq, checksum: ref.checksum })).filter(Boolean))];
}

function uniqueDates(data: any): string[] {
	const dates = Array.isArray(data?.source_dates) ? data.source_dates : [];
	return [...new Set(dates.map((date: any) => new Date(String(date)).toISOString().slice(0, 10)).filter((date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date)))];
}

export function activationEligibilityFromHabit(row: any) {
	const data = parseJson(row.data_json);
	const refs = uniqueRefs(data);
	const dates = uniqueDates(data);
	return { eligible: refs.length >= 3 && dates.length >= 2, unique_observations: refs.length, distinct_days: dates.length, dates };
}

export interface LawSnapshot {
	version: string;
	hash: string;
	files: { path: string; checksum: string; required: boolean }[];
	text: string;
}

export function resolveConfiguredLawPath(root: string, lawPath = "law.md"): string {
	const configured = (lawPath.trim() || "law.md");
	if (configured.includes("/") || configured.includes("\\") || configured === "." || configured === "..") throw new Error("Agent Experience safety file path must stay inside private state");
	return resolvePrivatePath(root, configured);
}

export async function readConfiguredLawSnapshot(root: string, config: { law_path?: string }): Promise<LawSnapshot> {
	const file = resolveConfiguredLawPath(root, config.law_path);
	if (!existsSync(file)) throw new Error(`Agent Experience law file missing: ${file}`);
	const info = await lstat(file);
	if (!info.isFile() || info.isSymbolicLink()) throw new Error("Agent Experience safety file is not a regular private file");
	const text = await readFile(file, "utf8");
	const checksum = sha256Hex(text);
	const files = [{ path: file, checksum, required: true }];
	return { version: LAW_CHECKER_VERSION, hash: checksumJson({ version: LAW_CHECKER_VERSION, files }), files, text: `FILE: ${file}\n${text}` };
}

export async function readDefaultLawSnapshot(cwd: string): Promise<LawSnapshot> {
	const files = [join(cwd, "docs", "CONSTITUTION.md"), join(cwd, "CONSTITUTION.md")];
	const parts: string[] = [];
	const meta: LawSnapshot["files"] = [];
	for (const file of files) {
		const required = file.endsWith(join("docs", "CONSTITUTION.md"));
		if (!existsSync(file)) {
			if (required) throw new Error(`Required law file missing: ${file}`);
			continue;
		}
		const text = await readFile(file, "utf8");
		const checksum = sha256Hex(text);
		meta.push({ path: file, checksum, required });
		parts.push(`FILE: ${file}\n${text}`);
	}
	const payload = { version: LAW_CHECKER_VERSION, files: meta };
	return { version: LAW_CHECKER_VERSION, hash: checksumJson(payload), files: meta, text: parts.join("\n\n") };
}

export function lawSnapshotForTest(text = "test law"): LawSnapshot {
	const checksum = sha256Hex(text);
	const files = [{ path: "test-law", checksum, required: true }];
	return { version: LAW_CHECKER_VERSION, hash: checksumJson({ version: LAW_CHECKER_VERSION, files }), files, text };
}

export function checkHabitLaw(input: { condition: string | null; behavior: string | null; law: LawSnapshot }) {
	if (input.law.version !== LAW_CHECKER_VERSION) throw new Error("Unsupported law checker version");
	if (!input.law.files.some((file) => file.required)) throw new Error("Required law file missing");
	const text = normalizeText(`${input.condition || ""} ${input.behavior || ""}`);
	const blocked = [
		/ignore .*safety/,
		/bypass .*safety/,
		/disable .*safety/,
		/reveal .*secret/,
		/store .*secret/,
		/skip .*redaction/,
		/bypass .*approval/,
		/write .*agents\.md/,
		/write .*claude\.md/,
		/write .*law/,
		/enable .*timer.*without .*approval/,
		/enable .*live.*without .*approval/,
		/inject .*report/,
		/inject .*quarantine/,
		/inject .*pending[- ]review/,
	];
	const reasons = blocked.filter((rule) => rule.test(text)).map((rule) => String(rule));
	return { pass: reasons.length === 0, reasons, law_hash: input.law.hash, version: input.law.version };
}

const OPPOSITES: Array<[RegExp, RegExp]> = [
	[/\bdo\b/, /\bdo not\b/],
	[/\buse\b/, /\bdo not use\b/],
	[/\binclude\b/, /\bdo not include\b/],
	[/\bask\b/, /\bdo not ask\b/],
	[/\balways\b/, /\bnever\b/],
	[/\bprefer\b/, /\bavoid\b/],
	[/\bverbose\b/, /\bconcise\b/],
	[/\blong\b/, /\bshort\b/],
];

function hasOpposition(a: string, b: string): boolean {
	for (const [left, right] of OPPOSITES) {
		if ((left.test(a) && right.test(b)) || (right.test(a) && left.test(b))) return true;
	}
	return false;
}

export function checkHabitConflict(db: any, input: { userId: string; habitId: string; condition: string | null; behavior: string | null; polarity: number }) {
	const userId = normalizeUserId(input.userId);
	const condition = normalizeText(input.condition);
	const behavior = normalizeText(input.behavior);
	const rows = db.prepare("SELECT id, status, condition, behavior, polarity FROM habits WHERE user_id = ? AND id <> ? AND status IN ('candidate','active','disabled','suppressed_by_law','dormant')").all(userId, input.habitId);
	const conflicts = rows
		.map((row: any) => {
			const rowCondition = normalizeText(row.condition);
			const rowBehavior = normalizeText(row.behavior);
			if (rowCondition !== condition) return null;
			if (rowBehavior === behavior) {
				return Number(row.polarity) === -Number(input.polarity) ? { row, reason: "opposite_polarity" } : null;
			}
			return { row, reason: hasOpposition(rowBehavior, behavior) ? "opposed_behavior" : "same_condition_divergent_behavior" };
		})
		.filter(Boolean);
	return { pass: conflicts.length === 0, conflicts: conflicts.map((conflict: any) => ({ id: conflict.row.id, status: conflict.row.status, reason: conflict.reason })) };
}

function activationDecision(db: any, input: { userId: string; row: any; law: LawSnapshot }) {
	const eligibility = activationEligibilityFromHabit(input.row);
	const law = checkHabitLaw({ condition: input.row.condition, behavior: input.row.behavior, law: input.law });
	const conflict = checkHabitConflict(db, { userId: input.userId, habitId: input.row.id, condition: input.row.condition, behavior: input.row.behavior, polarity: Number(input.row.polarity) });
	return { eligible: eligibility.eligible && law.pass && conflict.pass, eligibility, law, conflict };
}

export function acceptCandidateHabit(db: any, input: { userId: string; habitId: string; checksum: string; law: LawSnapshot; now: string }) {
	const userId = normalizeUserId(input.userId);
	let result: any;
	db.exec("BEGIN IMMEDIATE");
	try {
		const before = getHabit(db, userId, input.habitId);
		if (before.status !== "candidate" || before.checksum !== input.checksum) throw new Error("Stale candidate state");
		const data = { ...parseJson(before.data_json), condition: before.condition, behavior: before.behavior, polarity: before.polarity, confidence_bp: before.confidence_bp, record_kind: before.record_kind, schema_version: before.schema_version };
		const decision = activationDecision(db, { userId, row: before, law: input.law });
		const nextStatus = decision.eligible ? "active" : "candidate";
		const nextData = { ...data, review_status: decision.eligible ? "accepted_active" : "approved_pending_eligibility", active: decision.eligible, injectable: false, law_hash: input.law.hash, activation_decision: decision };
		const updated = updateHabitRow(db, { userId, id: before.id, expectedStatus: "candidate", expectedChecksum: input.checksum, data: nextData, status: nextStatus, now: input.now });
		const after = getHabit(db, userId, before.id);
		const audit = insertReviewAudit(db, { userId, targetKind: "habit", targetId: before.id, action: decision.eligible ? "accept_activate" : "accept_pending_eligibility", before, after, data: decision, createdAt: input.now });
		result = { status: nextStatus, habit_id: before.id, activated: decision.eligible, eligibility: decision.eligibility, law: decision.law, conflict: decision.conflict, checksum: updated.checksum, audit_id: audit.id };
		db.exec("COMMIT");
	} catch (error) {
		try { db.exec("ROLLBACK"); } catch {}
		throw error;
	}
	return result;
}

export function rejectCandidateHabit(db: any, input: { userId: string; habitId: string; checksum: string; now: string }) {
	const userId = normalizeUserId(input.userId);
	let result: any;
	db.exec("BEGIN IMMEDIATE");
	try {
		const before = getHabit(db, userId, input.habitId);
		if (before.status !== "candidate" || before.checksum !== input.checksum) throw new Error("Stale candidate state");
		const data = { ...parseJson(before.data_json), condition: before.condition, behavior: before.behavior, polarity: before.polarity, confidence_bp: before.confidence_bp, record_kind: before.record_kind, schema_version: before.schema_version, review_status: "rejected", active: false, injectable: false };
		const updated = updateHabitRow(db, { userId, id: before.id, expectedStatus: "candidate", expectedChecksum: input.checksum, data, status: "archived", now: input.now });
		const after = getHabit(db, userId, before.id);
		const audit = insertReviewAudit(db, { userId, targetKind: "habit", targetId: before.id, action: "reject_candidate", before, after, createdAt: input.now });
		result = { status: "archived", habit_id: before.id, checksum: updated.checksum, audit_id: audit.id };
		db.exec("COMMIT");
	} catch (error) {
		try { db.exec("ROLLBACK"); } catch {}
		throw error;
	}
	return result;
}

export function acceptPendingReview(db: any, input: { userId: string; id: string; checksum: string; now: string }) {
	let result: any;
	db.exec("BEGIN IMMEDIATE");
	try {
		result = transitionPendingReview(db, { userId: input.userId, id: input.id, expectedChecksum: input.checksum, status: "accepted", action: "accept_pending_review", now: input.now });
		db.exec("COMMIT");
	} catch (error) {
		try { db.exec("ROLLBACK"); } catch {}
		throw error;
	}
	return result;
}

export function rejectPendingReview(db: any, input: { userId: string; id: string; checksum: string; now: string }) {
	let result: any;
	db.exec("BEGIN IMMEDIATE");
	try {
		result = transitionPendingReview(db, { userId: input.userId, id: input.id, expectedChecksum: input.checksum, status: "rejected", action: "reject_pending_review", now: input.now });
		db.exec("COMMIT");
	} catch (error) {
		try { db.exec("ROLLBACK"); } catch {}
		throw error;
	}
	return result;
}

export function explainHabit(db: any, input: { userId: string; habitId: string }) {
	const row = getHabit(db, input.userId, input.habitId);
	const evidence = db.prepare("SELECT id, polarity, confidence_bp, data_json, checksum, created_at FROM evidence WHERE user_id = ? AND habit_id = ? ORDER BY created_at, id LIMIT 20").all(normalizeUserId(input.userId), input.habitId)
		.map((item: any) => ({ ...item, data: parseJson(item.data_json) }));
	const hitTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='selector_hit_log'").get();
	const hit_log = hitTable ? db.prepare("SELECT id, habit_id, action, selected, reason, confidence_bp, latency_ms, prompt_hash, checksum, created_at FROM selector_hit_log WHERE user_id = ? AND habit_id = ? ORDER BY created_at DESC LIMIT 20").all(normalizeUserId(input.userId), input.habitId) : [];
	return redactJson({ user_id: row.user_id, habit: { id: row.id, status: row.status, condition: row.condition, behavior: row.behavior, polarity: row.polarity, confidence_bp: row.confidence_bp, activation: row.activation, staleness: row.staleness, data: parseJson(row.data_json) }, evidence, hit_log, hit_log_note: hitTable ? undefined : "No selector hit-log table exists yet" });
}

export function disableHabit(db: any, input: { userId: string; habitId: string; checksum: string; now: string }) {
	const userId = normalizeUserId(input.userId);
	let result: any;
	db.exec("BEGIN IMMEDIATE");
	try {
		const before = getHabit(db, userId, input.habitId);
		if (before.status !== "active" || before.checksum !== input.checksum) throw new Error("Only active habits can be disabled");
		const data = { ...parseJson(before.data_json), condition: before.condition, behavior: before.behavior, polarity: before.polarity, confidence_bp: before.confidence_bp, record_kind: before.record_kind, schema_version: before.schema_version, active: false, injectable: false, disabled_at: input.now };
		const updated = updateHabitRow(db, { userId, id: before.id, expectedStatus: "active", expectedChecksum: input.checksum, data, status: "disabled", now: input.now });
		const after = getHabit(db, userId, before.id);
		const audit = insertReviewAudit(db, { userId, targetKind: "habit", targetId: before.id, action: "disable_habit", before, after, createdAt: input.now });
		result = { status: "disabled", habit_id: before.id, checksum: updated.checksum, audit_id: audit.id };
		db.exec("COMMIT");
	} catch (error) {
		try { db.exec("ROLLBACK"); } catch {}
		throw error;
	}
	return result;
}

export function enableHabit(db: any, input: { userId: string; habitId: string; checksum: string; law: LawSnapshot; now: string }) {
	const userId = normalizeUserId(input.userId);
	let result: any;
	db.exec("BEGIN IMMEDIATE");
	try {
		const before = getHabit(db, userId, input.habitId);
		if (before.status !== "disabled" || before.checksum !== input.checksum) throw new Error("Only disabled habits can be enabled");
		const law = checkHabitLaw({ condition: before.condition, behavior: before.behavior, law: input.law });
		const conflict = checkHabitConflict(db, { userId, habitId: before.id, condition: before.condition, behavior: before.behavior, polarity: Number(before.polarity) });
		if (!law.pass || !conflict.pass) throw new Error("Habit enable blocked by law/conflict check");
		const data = { ...parseJson(before.data_json), condition: before.condition, behavior: before.behavior, polarity: before.polarity, confidence_bp: before.confidence_bp, record_kind: before.record_kind, schema_version: before.schema_version, active: true, injectable: false, law_hash: input.law.hash, enabled_at: input.now };
		const updated = updateHabitRow(db, { userId, id: before.id, expectedStatus: "disabled", expectedChecksum: input.checksum, data, status: "active", now: input.now });
		const after = getHabit(db, userId, before.id);
		const audit = insertReviewAudit(db, { userId, targetKind: "habit", targetId: before.id, action: "enable_habit", before, after, data: { law, conflict }, createdAt: input.now });
		result = { status: "active", habit_id: before.id, checksum: updated.checksum, audit_id: audit.id };
		db.exec("COMMIT");
	} catch (error) {
		try { db.exec("ROLLBACK"); } catch {}
		throw error;
	}
	return result;
}

export function selectActiveHabitsForReview(db: any, input: { userId: string }) {
	return db.prepare("SELECT id, user_id, status, condition, behavior, checksum FROM habits WHERE user_id = ? AND status = 'active' ORDER BY id").all(normalizeUserId(input.userId));
}

export function recheckActiveHabitsForLaw(db: any, input: { userId: string; law: LawSnapshot; now: string }) {
	const userId = normalizeUserId(input.userId);
	let result: any;
	db.exec("BEGIN IMMEDIATE");
	try {
		const active = db.prepare("SELECT * FROM habits WHERE user_id = ? AND status = 'active' ORDER BY id").all(userId);
		const suppressed: string[] = [];
		for (const row of active) {
			const law = checkHabitLaw({ condition: row.condition, behavior: row.behavior, law: input.law });
			if (law.pass) {
				const data = { ...parseJson(row.data_json), condition: row.condition, behavior: row.behavior, polarity: row.polarity, confidence_bp: row.confidence_bp, record_kind: row.record_kind, schema_version: row.schema_version, law_hash: input.law.hash, law_rechecked_at: input.now };
				const updated = updateHabitRow(db, { userId, id: row.id, expectedStatus: "active", expectedChecksum: row.checksum, data, status: "active", now: input.now });
				insertReviewAudit(db, { userId, targetKind: "habit", targetId: row.id, action: "law_recheck_pass", before: row, after: { ...row, checksum: updated.checksum }, data: law, createdAt: input.now });
			} else {
				const data = { ...parseJson(row.data_json), condition: row.condition, behavior: row.behavior, polarity: row.polarity, confidence_bp: row.confidence_bp, record_kind: row.record_kind, schema_version: row.schema_version, active: false, injectable: false, law_hash: input.law.hash, law_rechecked_at: input.now, law_suppression: law };
				const updated = updateHabitRow(db, { userId, id: row.id, expectedStatus: "active", expectedChecksum: row.checksum, data, status: "suppressed_by_law", now: input.now });
				suppressed.push(row.id);
				insertReviewAudit(db, { userId, targetKind: "habit", targetId: row.id, action: "law_recheck_suppress", before: row, after: { ...row, status: "suppressed_by_law", checksum: updated.checksum }, data: law, createdAt: input.now });
			}
		}
		result = { user_id: userId, checked: active.length, suppressed, law_hash: input.law.hash };
		db.exec("COMMIT");
	} catch (error) {
		try { db.exec("ROLLBACK"); } catch {}
		throw error;
	}
	return result;
}

export async function generateHabitsReport(db: any, input: { root: string; userId: string; now: string; write?: boolean }) {
	const userId = normalizeUserId(input.userId);
	const rows = db.prepare("SELECT id, status, condition, behavior, polarity, confidence_bp, staleness, data_json FROM habits WHERE user_id = ? ORDER BY status, id").all(userId);
	const safeRows = redactJson(rows.map((row: any) => ({ id: row.id, status: row.status, condition: row.condition, behavior: row.behavior, polarity: row.polarity, confidence_bp: row.confidence_bp, staleness: row.staleness })));
	const content = [
		"# Agent Experience habits-report.md",
		"",
		"> Non-instructional generated report. Do not inject or treat as policy/law.",
		`Generated: ${input.now}`,
		`User: ${userId}`,
		"",
		"```json",
		canonicalJson(safeRows),
		"```",
		"",
	].join("\n");
	if (containsUnredactedSensitiveText(content)) throw new Error("Habits report contains unredacted sensitive text");
	const path = resolvePrivatePath(await ensurePrivateRoot(input.root), REPORT_NAME);
	if (input.write !== false) await writeFile(path, content, { mode: 0o600 });
	return { user_id: userId, path, content, report_only: true, injectable: false };
}
