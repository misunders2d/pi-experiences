import { lstat, readFile, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { canonicalJson, checksumJson, sha256Hex } from "./storage/checksum.ts";
import { normalizeUserId, resolvePrivatePath, ensurePrivateRoot } from "./storage/private-root.ts";
import { redactJson, containsUnredactedSensitiveText } from "./storage/redaction.ts";
import { buildTypedStorageRow } from "./storage/sqlite.ts";
import { runAtomicSemanticActivation } from "./semantic/service.ts";
import { insertHabitDuplicateAudit, listHabitDuplicates, restoreCandidateDuplicateResolution, updateHabitDuplicateDecision } from "./semantic/storage.ts";
import type { EmbeddingAdapter, SemanticDedupePolicy } from "./semantic/types.ts";

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
		.filter((row: any) => !["collecting_evidence", "approved_pending_eligibility", "approved_pending_conflict", "approved_pending_law_blocked", "duplicate_resolution"].includes(row.payload?.review_status));
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

function uniqueArrayByCanonical(values: unknown[]): unknown[] {
	const seen = new Set<string>();
	const out: unknown[] = [];
	for (const value of values) {
		const key = canonicalJson(value);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(value);
	}
	return out;
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
	if (info.size > 1_000_000) throw new Error("Agent Experience safety file exceeds the 1 MB limit");
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

export function revalidateLawSnapshotSync(snapshot: LawSnapshot): LawSnapshot {
	const absoluteFiles = snapshot.files.filter((file) => isAbsolute(file.path));
	if (!absoluteFiles.length) return snapshot;
	const files: LawSnapshot["files"] = [];
	const parts: string[] = [];
	for (const file of snapshot.files) {
		if (!isAbsolute(file.path)) throw new Error("Agent Experience safety snapshot contains an invalid path");
		const info = lstatSync(file.path);
		if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) throw new Error("Agent Experience safety file changed or is unsafe");
		const text = readFileSync(file.path, "utf8");
		const checksum = sha256Hex(text);
		if (checksum !== file.checksum) throw new Error("Agent Experience safety file changed; retry the action");
		files.push({ ...file, checksum });
		parts.push(`FILE: ${file.path}\n${text}`);
	}
	const hash = checksumJson({ version: LAW_CHECKER_VERSION, files });
	if (hash !== snapshot.hash) throw new Error("Agent Experience safety snapshot changed; retry the action");
	return { version: LAW_CHECKER_VERSION, hash, files, text: parts.join("\n\n") };
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

export async function acceptCandidateHabit(db: any, input: { userId: string; habitId: string; checksum: string; law: LawSnapshot; now: string; semantic?: { policy?: Partial<SemanticDedupePolicy>; provider?: EmbeddingAdapter; signal?: AbortSignal } }) {
	const userId = normalizeUserId(input.userId);
	const preflight = getHabit(db, userId, input.habitId);
	if (preflight.status !== "candidate" || preflight.checksum !== input.checksum) throw new Error("Stale candidate state");
	const approvalIdentity = (row: any) => ({ candidate_id: row.id, condition: normalizeText(row.condition), behavior: normalizeText(row.behavior), polarity: Number(row.polarity), approved_at: input.now });
	const outcome = await runAtomicSemanticActivation(db, {
		userId,
		targetHabitId: input.habitId,
		expectedStatus: "candidate",
		expectedChecksum: input.checksum,
		policy: input.semantic?.policy,
		provider: input.semantic?.provider,
		now: input.now,
		signal: input.semantic?.signal,
		targetKind: "accept_candidate",
		transition: (target, semantic) => {
			const before = getHabit(db, userId, target.id);
			const lawSnapshot = revalidateLawSnapshotSync(input.law);
			const decision = activationDecision(db, { userId, row: before, law: lawSnapshot });
			const nextStatus = decision.eligible ? "active" : "candidate";
			const pendingReason = !decision.eligibility.eligible ? "evidence" : !decision.law.pass ? "law" : !decision.conflict.pass ? "conflict" : undefined;
			const reviewStatus = decision.eligible ? "accepted_active" : pendingReason === "law" ? "approved_pending_law_blocked" : pendingReason === "conflict" ? "approved_pending_conflict" : "approved_pending_eligibility";
			const data = { ...parseJson(before.data_json), condition: before.condition, behavior: before.behavior, polarity: before.polarity, confidence_bp: before.confidence_bp, record_kind: before.record_kind, schema_version: before.schema_version, review_status: reviewStatus, active: decision.eligible, injectable: false, law_hash: lawSnapshot.hash, approved_identity: approvalIdentity(before), approved_pending_reason: pendingReason, activation_decision: { ...decision, semantic } };
			const updated = updateHabitRow(db, { userId, id: before.id, expectedStatus: "candidate", expectedChecksum: before.checksum, data, status: nextStatus, now: input.now });
			const after = getHabit(db, userId, before.id);
			const audit = insertReviewAudit(db, { userId, targetKind: "habit", targetId: before.id, action: decision.eligible ? "accept_activate" : `accept_pending_${pendingReason || "eligibility"}`, before, after, data: { ...decision, semantic, approved_identity: approvalIdentity(before) }, createdAt: input.now });
			return { status: nextStatus, habit_id: before.id, activated: decision.eligible, eligibility: decision.eligibility, law: decision.law, conflict: decision.conflict, semantic, checksum: updated.checksum, audit_id: audit.id };
		},
		onBlocked: (target, semantic) => {
			const before = getHabit(db, userId, target.id);
			const duplicate = semantic.reason === "semantic_duplicate";
			const data = { ...parseJson(before.data_json), condition: before.condition, behavior: before.behavior, polarity: before.polarity, confidence_bp: before.confidence_bp, record_kind: before.record_kind, schema_version: before.schema_version, review_status: duplicate ? "duplicate_resolution" : "approved_pending_eligibility", active: false, injectable: false, approved_identity: approvalIdentity(before), approved_pending_reason: semantic.reason, activation_decision: { semantic } };
			const updated = updateHabitRow(db, { userId, id: before.id, expectedStatus: "candidate", expectedChecksum: before.checksum, data, status: "candidate", now: input.now });
			const after = getHabit(db, userId, before.id);
			const audit = insertReviewAudit(db, { userId, targetKind: "habit", targetId: before.id, action: duplicate ? "accept_pending_duplicate_resolution" : "accept_pending_semantic_unavailable", before, after, data: { semantic, approved_identity: approvalIdentity(before) }, createdAt: input.now });
			return { status: "candidate", habit_id: before.id, activated: false, semantic, checksum: updated.checksum, audit_id: audit.id };
		},
	});
	return outcome.result || { status: outcome.target.status, habit_id: outcome.target.id, activated: false, semantic: outcome.semantic, checksum: outcome.target.checksum };
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

export async function enableHabit(db: any, input: { userId: string; habitId: string; checksum: string; law: LawSnapshot; now: string; semantic?: { policy?: Partial<SemanticDedupePolicy>; provider?: EmbeddingAdapter; signal?: AbortSignal } }) {
	const userId = normalizeUserId(input.userId);
	const preflight = getHabit(db, userId, input.habitId);
	if (preflight.status !== "disabled" || preflight.checksum !== input.checksum) throw new Error("Only disabled habits can be enabled");
	const outcome = await runAtomicSemanticActivation(db, {
		userId,
		targetHabitId: input.habitId,
		expectedStatus: "disabled",
		expectedChecksum: input.checksum,
		policy: input.semantic?.policy,
		provider: input.semantic?.provider,
		now: input.now,
		signal: input.semantic?.signal,
		targetKind: "enable_habit",
		transition: (target, semantic) => {
			const before = getHabit(db, userId, target.id);
			const lawSnapshot = revalidateLawSnapshotSync(input.law);
			const law = checkHabitLaw({ condition: before.condition, behavior: before.behavior, law: lawSnapshot });
			const conflict = checkHabitConflict(db, { userId, habitId: before.id, condition: before.condition, behavior: before.behavior, polarity: Number(before.polarity) });
			if (!law.pass || !conflict.pass) throw new Error("Habit enable blocked by law/conflict check");
			const data = { ...parseJson(before.data_json), condition: before.condition, behavior: before.behavior, polarity: before.polarity, confidence_bp: before.confidence_bp, record_kind: before.record_kind, schema_version: before.schema_version, active: true, injectable: false, law_hash: lawSnapshot.hash, enabled_at: input.now };
			const updated = updateHabitRow(db, { userId, id: before.id, expectedStatus: "disabled", expectedChecksum: before.checksum, data, status: "active", now: input.now });
			const after = getHabit(db, userId, before.id);
			const audit = insertReviewAudit(db, { userId, targetKind: "habit", targetId: before.id, action: "enable_habit", before, after, data: { law, conflict, semantic }, createdAt: input.now });
			return { status: "active", habit_id: before.id, enabled: true, checksum: updated.checksum, audit_id: audit.id, semantic };
		},
	});
	return outcome.result || { status: outcome.target.status, habit_id: outcome.target.id, enabled: false, semantic: outcome.semantic, checksum: outcome.target.checksum };
}

export type HabitDuplicateResolutionAction = "merge" | "supersede" | "keep_separate" | "archive_duplicate";

export interface HabitDuplicateResolutionPlan {
	action: HabitDuplicateResolutionAction;
	survivor: any;
	other: any;
	archivesOther: boolean;
	combinesEvidence: boolean;
}

export function planHabitDuplicateResolution(relation: any, habits: any[], action: HabitDuplicateResolutionAction): HabitDuplicateResolutionPlan {
	const canonicalId = String(relation?.canonical_habit_id || "");
	const duplicateId = String(relation?.duplicate_habit_id || "");
	if (!canonicalId || !duplicateId || canonicalId === duplicateId) throw new Error("Duplicate item changed; refresh required");
	const byId = new Map(habits.map((habit) => [String(habit.id), habit]));
	let survivor = byId.get(action === "supersede" ? duplicateId : canonicalId);
	let other = byId.get(action === "supersede" ? canonicalId : duplicateId);
	if (!survivor || !other) throw new Error("Duplicate habit changed; refresh required");
	if (action === "merge" && survivor.status === "candidate" && (other.status === "active" || other.status === "disabled")) {
		[survivor, other] = [other, survivor];
	}
	return {
		action,
		survivor,
		other,
		archivesOther: action !== "keep_separate",
		combinesEvidence: action === "merge" || action === "supersede",
	};
}

export function resolveHabitDuplicate(db: any, input: { userId: string; duplicateId: string; checksum: string; action: HabitDuplicateResolutionAction; reason?: string; law?: LawSnapshot; expectedHabitChecksums?: Record<string, string>; now: string }) {
	const userId = normalizeUserId(input.userId);
	let result: any;
	db.exec("BEGIN IMMEDIATE");
	try {
		const before = db.prepare("SELECT * FROM habit_duplicates WHERE user_id = ? AND id = ?").get(userId, input.duplicateId);
		if (!before || before.checksum !== input.checksum || before.decision !== "pending") throw new Error("Duplicate item changed; refresh required");
		const relationCanonicalId = String(before.canonical_habit_id || "");
		const relationDuplicateId = String(before.duplicate_habit_id || "");
		if (!relationCanonicalId || !relationDuplicateId || relationCanonicalId === relationDuplicateId) throw new Error("Duplicate item changed; refresh required");
		const relationHabits = [
			getHabit(db, userId, relationCanonicalId),
			getHabit(db, userId, relationDuplicateId),
		];
		if (input.expectedHabitChecksums) {
			for (const habit of relationHabits) {
				if (!input.expectedHabitChecksums[habit.id] || input.expectedHabitChecksums[habit.id] !== habit.checksum) throw new Error("Duplicate habit changed; refresh required");
			}
		}
		const plan = planHabitDuplicateResolution(before, relationHabits, input.action);
		let canonicalId = plan.survivor.id;
		let duplicateId = plan.other.id;
		let canonicalHabit = plan.survivor;
		let duplicateHabit = plan.other;
		if ((input.action === "merge" || input.action === "supersede") && canonicalHabit && duplicateHabit) {
			const canonicalData = { ...parseJson(canonicalHabit.data_json), condition: canonicalHabit.condition, behavior: canonicalHabit.behavior, polarity: canonicalHabit.polarity, confidence_bp: canonicalHabit.confidence_bp, record_kind: canonicalHabit.record_kind, schema_version: canonicalHabit.schema_version };
			const duplicateData = parseJson(duplicateHabit.data_json);
			const mergedData = {
				...canonicalData,
				source_refs: uniqueArrayByCanonical([...(Array.isArray(canonicalData.source_refs) ? canonicalData.source_refs : []), ...(Array.isArray(duplicateData.source_refs) ? duplicateData.source_refs : [])]),
				source_dates: uniqueArrayByCanonical([...(Array.isArray(canonicalData.source_dates) ? canonicalData.source_dates : []), ...(Array.isArray(duplicateData.source_dates) ? duplicateData.source_dates : [])]).sort(),
				semantic_duplicate_resolution: { action: input.action, duplicate_id: before.id, resolved_at: input.now },
			};
			updateHabitRow(db, { userId, id: canonicalHabit.id, expectedStatus: canonicalHabit.status, expectedChecksum: canonicalHabit.checksum, data: mergedData, status: canonicalHabit.status, now: input.now });
			const canonicalAfterMerge = getHabit(db, userId, canonicalHabit.id);
			insertReviewAudit(db, { userId, targetKind: "habit", targetId: canonicalHabit.id, action: `resolve_duplicate_${input.action}_canonical`, before: canonicalHabit, after: canonicalAfterMerge, data: { duplicate_id: before.id, source_habit_id: duplicateHabit.id }, createdAt: input.now });
			canonicalHabit = canonicalAfterMerge;
			const evidenceRows = db.prepare("SELECT * FROM evidence WHERE user_id = ? AND habit_id = ? ORDER BY id").all(userId, duplicateHabit.id);
			for (const evidence of evidenceRows) {
				const evidenceData = { ...parseJson(evidence.data_json), record_kind: evidence.record_kind, schema_version: evidence.schema_version, status: evidence.status, habit_id: canonicalHabit.id, condition: evidence.condition, behavior: evidence.behavior, polarity: evidence.polarity, confidence_bp: evidence.confidence_bp, activation: evidence.activation, staleness: evidence.staleness };
				const row = buildTypedStorageRow("evidence", { id: evidence.id, userId, data: evidenceData, createdAt: evidence.created_at, updatedAt: input.now });
				db.prepare("UPDATE evidence SET record_kind=?, schema_version=?, status=?, habit_id=?, condition=?, behavior=?, polarity=?, confidence_bp=?, activation=?, staleness=?, data_json=?, checksum=?, updated_at=? WHERE user_id=? AND id=? AND checksum=?")
					.run(row.record_kind, row.schema_version, row.status, row.habit_id, row.condition, row.behavior, row.polarity, row.confidence_bp, row.activation, row.staleness, row.data_json, row.checksum, row.updated_at, userId, evidence.id, evidence.checksum);
			}
		}
		if (input.action === "supersede" && canonicalHabit?.status === "candidate" && (duplicateHabit?.status === "active" || duplicateHabit?.status === "disabled")) {
			if (!input.law) throw new Error("Supersede requires law check before replacing an approved habit");
			const lawSnapshot = revalidateLawSnapshotSync(input.law);
			const law = checkHabitLaw({ condition: canonicalHabit.condition, behavior: canonicalHabit.behavior, law: lawSnapshot });
			if (!law.pass) throw new Error("Supersede replacement blocked by law check");
			const conflict = checkHabitConflict(db, { userId, habitId: canonicalHabit.id, condition: canonicalHabit.condition, behavior: canonicalHabit.behavior, polarity: Number(canonicalHabit.polarity) });
			const blockingConflicts = conflict.conflicts.filter((item: any) => item.id !== duplicateHabit.id);
			if (blockingConflicts.length) throw new Error("Supersede replacement blocked by conflict check");
			const replacementData = { ...parseJson(canonicalHabit.data_json), condition: canonicalHabit.condition, behavior: canonicalHabit.behavior, polarity: canonicalHabit.polarity, confidence_bp: canonicalHabit.confidence_bp, record_kind: canonicalHabit.record_kind, schema_version: canonicalHabit.schema_version, review_status: duplicateHabit.status === "active" ? "supersede_active" : "supersede_disabled", active: duplicateHabit.status === "active", injectable: false, law_hash: lawSnapshot.hash, superseded_habit_id: duplicateHabit.id, superseded_at: input.now, supersede_conflict_check: { ...conflict, conflicts: blockingConflicts } };
			const replacementBefore = canonicalHabit;
			updateHabitRow(db, { userId, id: canonicalHabit.id, expectedStatus: canonicalHabit.status, expectedChecksum: canonicalHabit.checksum, data: replacementData, status: duplicateHabit.status, now: input.now });
			canonicalHabit = getHabit(db, userId, canonicalHabit.id);
			insertReviewAudit(db, { userId, targetKind: "habit", targetId: canonicalHabit.id, action: "supersede_promote_replacement", before: replacementBefore, after: canonicalHabit, data: { duplicate_id: before.id, replaced_habit_id: duplicateHabit.id, law, conflict: { ...conflict, conflicts: blockingConflicts } }, createdAt: input.now });
		}
		if ((input.action === "merge" || input.action === "supersede" || input.action === "archive_duplicate") && duplicateHabit && duplicateHabit.status !== "archived") {
			const duplicateData = { ...parseJson(duplicateHabit.data_json), condition: duplicateHabit.condition, behavior: duplicateHabit.behavior, polarity: duplicateHabit.polarity, confidence_bp: duplicateHabit.confidence_bp, record_kind: duplicateHabit.record_kind, schema_version: duplicateHabit.schema_version, active: false, injectable: false, archived_at: input.now, hidden_at: input.now, merged_into: input.action === "merge" ? canonicalId : undefined, superseded_by: input.action === "supersede" ? canonicalId : undefined, archive_reason: input.action };
			updateHabitRow(db, { userId, id: duplicateHabit.id, expectedStatus: duplicateHabit.status, expectedChecksum: duplicateHabit.checksum, data: duplicateData, status: "archived", now: input.now });
			const duplicateAfterArchive = getHabit(db, userId, duplicateHabit.id);
			insertReviewAudit(db, { userId, targetKind: "habit", targetId: duplicateHabit.id, action: `resolve_duplicate_${input.action}_archive`, before: duplicateHabit, after: duplicateAfterArchive, data: { duplicate_id: before.id, canonical_habit_id: canonicalId }, createdAt: input.now });
		}
		const decision = input.action === "keep_separate" ? "kept_separate" : input.action === "archive_duplicate" ? "archived_duplicate" : input.action === "supersede" ? "superseded" : "merged";
		const data = { ...parseJson(before.data_json), resolution: { action: input.action, reason: input.reason || "setup", resolved_at: input.now, canonical_habit_id: canonicalId, duplicate_habit_id: duplicateId } };
		const dataJson = boundedJson(data);
		const afterBase = { user_id: before.user_id, pair_key: before.pair_key, habit_a: before.habit_a, habit_b: before.habit_b, canonical_habit_id: canonicalId, duplicate_habit_id: duplicateId, similarity_bp: Number(before.similarity_bp), threshold_bp: Number(before.threshold_bp), method: before.method, provider: before.provider, model: before.model, dimensions: before.dimensions === null ? null : Number(before.dimensions), decision, data_json: dataJson, created_at: before.created_at, updated_at: input.now, decided_at: input.now };
		const checksum = checksumJson({ table: "habit_duplicates", row: afterBase });
		const relationUpdate = db.prepare("UPDATE habit_duplicates SET canonical_habit_id=?, duplicate_habit_id=?, decision=?, data_json=?, checksum=?, updated_at=?, decided_at=? WHERE user_id=? AND id=? AND checksum=?")
			.run(canonicalId, duplicateId, decision, dataJson, checksum, input.now, input.now, userId, before.id, input.checksum);
		if (relationUpdate.changes !== 1) throw new Error("Duplicate item changed; refresh required");
		if (input.action === "keep_separate") {
			for (const planned of [canonicalHabit, duplicateHabit].filter(Boolean)) {
				const habitBeforeRestore = getHabit(db, userId, planned.id);
				if (habitBeforeRestore.status !== "candidate") continue;
				const restored = restoreCandidateDuplicateResolution(db, { userId, habitId: planned.id, relationId: before.id, reviewStatus: "kept_separate", data: { action: "keep_separate", reason: input.reason || "setup" }, now: input.now });
				if (restored.updated) insertReviewAudit(db, { userId, targetKind: "habit", targetId: planned.id, action: "resolve_duplicate_keep_separate_unhide", before: restored.before, after: restored.after, data: { duplicate_id: before.id, reason: input.reason || "setup" }, createdAt: input.now });
			}
		}
		const after = db.prepare("SELECT * FROM habit_duplicates WHERE user_id = ? AND id = ?").get(userId, before.id);
		const audit = insertHabitDuplicateAudit(db, { userId, duplicateId: before.id, targetKind: "habit_duplicate", targetId: before.id, action: `resolve_${decision}`, before, after, data, now: input.now });
		result = { duplicate_id: before.id, decision, audit_id: audit.id };
		db.exec("COMMIT");
	} catch (error) {
		try { db.exec("ROLLBACK"); } catch {}
		throw error;
	}
	return result;
}

export function archiveHideHabit(db: any, input: { userId: string; habitId: string; checksum: string; now: string }) {
	const userId = normalizeUserId(input.userId);
	let result: any;
	db.exec("BEGIN IMMEDIATE");
	try {
		const before = getHabit(db, userId, input.habitId);
		if ((before.status !== "active" && before.status !== "disabled") || before.checksum !== input.checksum) throw new Error("Only current approved habits can be archived/hidden");
		const data = { ...parseJson(before.data_json), condition: before.condition, behavior: before.behavior, polarity: before.polarity, confidence_bp: before.confidence_bp, record_kind: before.record_kind, schema_version: before.schema_version, active: false, injectable: false, archived_at: input.now, hidden_at: input.now, archive_reason: "user_hidden_from_setup" };
		const updated = updateHabitRow(db, { userId, id: before.id, expectedStatus: before.status, expectedChecksum: input.checksum, data, status: "archived", now: input.now });
		const after = getHabit(db, userId, before.id);
		const audit = insertReviewAudit(db, { userId, targetKind: "habit", targetId: before.id, action: "archive_hide_habit", before, after, createdAt: input.now });
		const openDuplicates = listHabitDuplicates(db, { userId, decision: "pending" }).filter((row: any) => row.habit_a === before.id || row.habit_b === before.id);
		const duplicate_audit_ids: string[] = [];
		for (const duplicate of openDuplicates) {
			const relationData = { ...parseJson(duplicate.data_json), resolution: { action: "archive_hide_habit", reason: "archived_hidden", resolved_at: input.now, archived_habit_id: before.id } };
			const changed = updateHabitDuplicateDecision(db, { userId, duplicateId: duplicate.id, decision: "archived_duplicate", data: relationData, now: input.now });
			restoreCandidateDuplicateResolution(db, { userId, habitId: duplicate.habit_a, relationId: duplicate.id, reviewStatus: "duplicate_source_archived", data: { reason: "archive_hide_habit", archived_habit_id: before.id }, now: input.now });
			restoreCandidateDuplicateResolution(db, { userId, habitId: duplicate.habit_b, relationId: duplicate.id, reviewStatus: "duplicate_source_archived", data: { reason: "archive_hide_habit", archived_habit_id: before.id }, now: input.now });
			const relationAudit = insertHabitDuplicateAudit(db, { userId, duplicateId: duplicate.id, targetKind: "habit", targetId: before.id, action: "archive_hide_habit_relation_resolve", before: changed.before, after: changed.after, data: { resolution_reason: "archived_hidden" }, now: input.now });
			duplicate_audit_ids.push(relationAudit.id);
		}
		result = { status: "archived", habit_id: before.id, checksum: updated.checksum, audit_id: audit.id, duplicate_audit_ids };
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

export function listApprovedHabitsForSetup(db: any, input: { userId: string }) {
	return db.prepare("SELECT id, user_id, status, condition, behavior, polarity, confidence_bp, activation, staleness, data_json, checksum, created_at, updated_at FROM habits WHERE user_id = ? AND status IN ('active','disabled') ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC, id")
		.all(normalizeUserId(input.userId))
		.map((row: any) => ({ ...row, data: parseJson(row.data_json) }));
}

export function listApprovedPendingHabitsForSetup(db: any, input: { userId: string }) {
	const waiting = new Set(["approved_pending_eligibility", "approved_pending_conflict", "approved_pending_law_blocked"]);
	return db.prepare("SELECT id, user_id, status, condition, behavior, polarity, confidence_bp, data_json, checksum, created_at, updated_at FROM habits WHERE user_id = ? AND status IN ('candidate','suppressed_by_law') ORDER BY updated_at DESC, id")
		.all(normalizeUserId(input.userId))
		.map((row: any) => ({ ...row, data: parseJson(row.data_json) }))
		.filter((row: any) => waiting.has(row.data.review_status))
		.map((row: any) => ({ ...row, waiting_reason: row.data.approved_pending_reason || (row.data.review_status === "approved_pending_law_blocked" ? "law" : row.data.review_status === "approved_pending_conflict" ? "conflict" : "evidence") }));
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
