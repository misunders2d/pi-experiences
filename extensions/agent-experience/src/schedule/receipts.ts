import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { basename } from "node:path";
import { canonicalJson } from "../storage/checksum.ts";
import { withOwnedLock } from "../storage/locks.ts";
import { ensurePrivateRoot, resolvePrivatePath } from "../storage/private-root.ts";

export type ScheduledAnalyzeReceiptStatus = "ok" | "failed" | "no_work" | "locked" | "disabled";

export type ScheduledAnalyzeBreakInDeliveryState = "queued" | "prompted";

export interface ScheduledAnalyzeReceipt {
	schema_version: 1;
	id: string;
	kind: "scheduled_analyze";
	user_id: string;
	created_at: string;
	status: ScheduledAnalyzeReceiptStatus;
	severity: "info" | "warn";
	checked?: number;
	total_unread?: number;
	new_suggestions?: number;
	has_more?: boolean;
	safe_code?: string;
	queue_overflowed?: true;
	break_in_delivery?: { state: ScheduledAnalyzeBreakInDeliveryState; updated_at: string };
}

export interface ScheduledAnalyzeReceiptRecord {
	file: string;
	receipt: ScheduledAnalyzeReceipt;
}

const MAX_PENDING_RECEIPTS = 20;
const RECEIPT_FILE_RE = /^\d{17}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;
const SAFE_CODES = new Set([
	"config_gate_denied",
	"consolidation_locked",
	"lock_io_error",
	"model_auth_unavailable",
	"model_not_found",
	"model_call_failed",
	"model_output_invalid",
	"storage_io_error",
	"receipt_queue_overflow",
]);

function pendingDir(root: string): string {
	return resolvePrivatePath(root, "receipts", "scheduled-analyze", "pending");
}

function receiptFileName(receipt: ScheduledAnalyzeReceipt): string {
	const stamp = receipt.created_at.replace(/[^0-9]/g, "").slice(0, 17) || String(Date.now()).padStart(17, "0");
	return `${stamp}-${receipt.id}.json`;
}

function boundedCount(value: unknown): number | undefined {
	if (!Number.isInteger(value) || Number(value) < 0) return undefined;
	return Math.min(Number(value), 1_000_000_000);
}

function validateReceipt(value: unknown): ScheduledAnalyzeReceipt {
	const raw = value as any;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("scheduled_receipt_invalid");
	if (raw.schema_version !== 1 || raw.kind !== "scheduled_analyze") throw new Error("scheduled_receipt_invalid");
	if (typeof raw.id !== "string" || !/^[0-9a-f-]{36}$/i.test(raw.id)) throw new Error("scheduled_receipt_invalid");
	if (typeof raw.user_id !== "string" || !raw.user_id || raw.user_id.length > 200) throw new Error("scheduled_receipt_invalid");
	if (typeof raw.created_at !== "string" || !Number.isFinite(Date.parse(raw.created_at))) throw new Error("scheduled_receipt_invalid");
	if (!["ok", "failed", "no_work", "locked", "disabled"].includes(raw.status)) throw new Error("scheduled_receipt_invalid");
	if (!["info", "warn"].includes(raw.severity)) throw new Error("scheduled_receipt_invalid");
	if (raw.safe_code !== undefined && (typeof raw.safe_code !== "string" || !SAFE_CODES.has(raw.safe_code))) throw new Error("scheduled_receipt_invalid");
	const receipt: ScheduledAnalyzeReceipt = {
		schema_version: 1,
		id: raw.id,
		kind: "scheduled_analyze",
		user_id: raw.user_id,
		created_at: new Date(raw.created_at).toISOString(),
		status: raw.status,
		severity: raw.severity,
	};
	for (const [source, target] of [["checked", "checked"], ["total_unread", "total_unread"], ["new_suggestions", "new_suggestions"]] as const) {
		const count = boundedCount(raw[source]);
		if (count !== undefined) (receipt as any)[target] = count;
	}
	if (typeof raw.has_more === "boolean") receipt.has_more = raw.has_more;
	if (raw.safe_code) receipt.safe_code = raw.safe_code;
	if (raw.queue_overflowed === true) receipt.queue_overflowed = true;
	if (raw.break_in_delivery !== undefined) {
		const delivery = raw.break_in_delivery;
		if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) throw new Error("scheduled_receipt_invalid");
		if (Object.keys(delivery).some((key) => key !== "state" && key !== "updated_at")) throw new Error("scheduled_receipt_invalid");
		if (delivery.state !== "queued" && delivery.state !== "prompted") throw new Error("scheduled_receipt_invalid");
		if (typeof delivery.updated_at !== "string" || !Number.isFinite(Date.parse(delivery.updated_at))) throw new Error("scheduled_receipt_invalid");
		receipt.break_in_delivery = { state: delivery.state, updated_at: new Date(delivery.updated_at).toISOString() };
	}
	return receipt;
}

async function listReceiptFiles(root: string): Promise<string[]> {
	const dir = pendingDir(root);
	try {
		const info = await lstat(dir);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("scheduled_receipt_directory_invalid");
		return (await readdir(dir)).filter((name) => RECEIPT_FILE_RE.test(name)).sort();
	} catch (error: any) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
}

async function fsyncDirectory(path: string): Promise<void> {
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY);
		await handle.sync();
	} catch {
		// Atomic rename already completed. Directory fsync is best-effort on filesystems
		// that do not permit syncing directory descriptors.
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function makeRoom(root: string): Promise<boolean> {
	const dir = pendingDir(root);
	const files = await listReceiptFiles(root);
	if (files.length < MAX_PENDING_RECEIPTS) return false;
	const ranked: { file: string; rank: number }[] = [];
	for (const file of files) {
		let rank = 2;
		try {
			const receipt = validateReceipt(JSON.parse(await readFile(resolvePrivatePath(dir, file), "utf8")));
			if (receipt.break_in_delivery?.state === "queued") rank = 1;
			else if (receipt.status === "ok" || receipt.status === "no_work") rank = 0;
			else if (receipt.status === "locked" || receipt.status === "disabled") rank = 1;
		} catch {
			// Preserve unreadable evidence before valid informational receipts.
			rank = 3;
		}
		ranked.push({ file, rank });
	}
	ranked.sort((a, b) => a.rank - b.rank || a.file.localeCompare(b.file));
	const removeCount = files.length - MAX_PENDING_RECEIPTS + 1;
	const removable = ranked.filter((entry) => entry.rank < 3).slice(0, removeCount);
	if (removable.length < removeCount) throw new Error("scheduled_receipt_queue_blocked_by_unreadable_state");
	for (const entry of removable) await rm(resolvePrivatePath(dir, entry.file), { force: true });
	return removeCount > 0;
}

export async function writeScheduledAnalyzeReceipt(root: string, input: Omit<ScheduledAnalyzeReceipt, "schema_version" | "id" | "kind" | "created_at"> & { created_at?: string }): Promise<ScheduledAnalyzeReceipt> {
	await ensurePrivateRoot(root);
	return withOwnedLock(root, "scheduled-receipts", async () => {
	const dir = pendingDir(root);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700);
	const overflowed = await makeRoom(root);
	const receipt = validateReceipt({
		schema_version: 1,
		id: randomUUID(),
		kind: "scheduled_analyze",
		created_at: input.created_at || new Date().toISOString(),
		...input,
		...(overflowed ? { queue_overflowed: true } : {}),
	});
	const file = receiptFileName(receipt);
	const target = resolvePrivatePath(dir, file);
	const temp = resolvePrivatePath(dir, `.tmp-${receipt.id}`);
	const nofollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | nofollow, 0o600);
	try {
		await handle.writeFile(canonicalJson(receipt), "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temp, target);
	await chmod(target, 0o600);
	await fsyncDirectory(dir);
	return receipt;
	}, { waitMs: 2_000 });
}

export async function readScheduledAnalyzeReceipts(root: string): Promise<{ receipts: ScheduledAnalyzeReceipt[]; files: string[]; unreadable: number }> {
	const dir = pendingDir(root);
	const receipts: ScheduledAnalyzeReceipt[] = [];
	const files: string[] = [];
	let unreadable = 0;
	for (const file of await listReceiptFiles(root)) {
		try {
			const path = resolvePrivatePath(dir, file);
			const info = await lstat(path);
			if (!info.isFile() || info.isSymbolicLink()) throw new Error("scheduled_receipt_invalid");
			const receipt = validateReceipt(JSON.parse(await readFile(path, "utf8")));
			receipts.push(receipt);
			files.push(file);
		} catch {
			unreadable += 1;
		}
	}
	return { receipts, files, unreadable };
}

export function formatScheduledAnalyzeReceiptSummary(data: { receipts: ScheduledAnalyzeReceipt[]; unreadable: number }): string | undefined {
	if (!data.receipts.length && !data.unreadable) return undefined;
	const ok = data.receipts.filter((receipt) => receipt.status === "ok");
	const failed = data.receipts.filter((receipt) => receipt.status === "failed");
	const checked = ok.reduce((sum, receipt) => sum + (receipt.checked || 0), 0);
	const suggestions = ok.reduce((sum, receipt) => sum + (receipt.new_suggestions || 0), 0);
	const noWork = data.receipts.filter((receipt) => receipt.status === "no_work").length;
	const locked = data.receipts.filter((receipt) => receipt.status === "locked").length;
	const disabled = data.receipts.filter((receipt) => receipt.status === "disabled").length;
	const overflowed = data.receipts.some((receipt) => receipt.queue_overflowed);
	const lines = ["Scheduled Agent Experience Analyze update:"];
	if (ok.length) lines.push(`${checked} saved example${checked === 1 ? "" : "s"} checked; ${suggestions} new suggestion${suggestions === 1 ? "" : "s"} created.`);
	if (noWork) lines.push(`${noWork} scheduled run${noWork === 1 ? "" : "s"} found no unread saved examples; no model call was made.`);
	if (locked) lines.push(`${locked} scheduled run${locked === 1 ? "" : "s"} skipped because Analyze was already running.`);
	if (disabled) lines.push(`${disabled} scheduled run${disabled === 1 ? "" : "s"} skipped because the configured gates were off.`);
	if (failed.length) lines.push(`${failed.length} scheduled run${failed.length === 1 ? "" : "s"} failed safely. Open /experience setup to inspect or retry.`);
	if (data.unreadable) lines.push(`${data.unreadable} private receipt${data.unreadable === 1 ? " is" : "s are"} unreadable and was retained for safe recovery.`);
	if (overflowed) lines.push("Older informational receipts were compacted because the private receipt queue reached its bound.");
	if (suggestions) lines.push("Next: /experience setup → Review suggested habits. Nothing was approved automatically.");
	return lines.join("\n");
}

async function replaceScheduledAnalyzeReceiptFile(root: string, file: string, receipt: ScheduledAnalyzeReceipt): Promise<void> {
	if (basename(file) !== file || !RECEIPT_FILE_RE.test(file)) throw new Error("scheduled_receipt_invalid_filename");
	const dir = pendingDir(root);
	const target = resolvePrivatePath(dir, file);
	const temp = resolvePrivatePath(dir, `.tmp-${randomUUID()}`);
	const nofollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | nofollow, 0o600);
	try {
		await handle.writeFile(canonicalJson(validateReceipt(receipt)), "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temp, target);
	await chmod(target, 0o600);
	await fsyncDirectory(dir);
}

export type ScheduledAnalyzeBreakInTransitionResult = "updated" | "missing" | "mismatch" | "invalid" | "already_marked";

export async function transitionScheduledAnalyzeReceiptBreakInDelivery(root: string, input: {
	file: string;
	receiptId: string;
	userId: string;
	expected: "none" | "queued";
	next: ScheduledAnalyzeBreakInDeliveryState;
	updatedAt?: string;
}): Promise<ScheduledAnalyzeBreakInTransitionResult> {
	if (basename(input.file) !== input.file || !RECEIPT_FILE_RE.test(input.file)) return "invalid";
	return withOwnedLock(root, "scheduled-receipts", async () => {
		const path = resolvePrivatePath(pendingDir(root), input.file);
		let receipt: ScheduledAnalyzeReceipt;
		try {
			const info = await lstat(path);
			if (!info.isFile() || info.isSymbolicLink()) return "invalid";
			receipt = validateReceipt(JSON.parse(await readFile(path, "utf8")));
		} catch (error: any) {
			if (error?.code === "ENOENT") return "missing";
			return "invalid";
		}
		if (receipt.id !== input.receiptId || receipt.user_id !== input.userId) return "mismatch";
		const current = receipt.break_in_delivery?.state;
		if (current === input.next) return "already_marked";
		if ((input.expected === "none" && current !== undefined) || (input.expected === "queued" && current !== "queued")) return "mismatch";
		const updatedAt = input.updatedAt || new Date().toISOString();
		if (!Number.isFinite(Date.parse(updatedAt))) return "invalid";
		await replaceScheduledAnalyzeReceiptFile(root, input.file, {
			...receipt,
			break_in_delivery: { state: input.next, updated_at: new Date(updatedAt).toISOString() },
		});
		return "updated";
	}, { waitMs: 2_000 });
}

export function isScheduledAnalyzeBreakInEligible(receipt: ScheduledAnalyzeReceipt): boolean {
	return receipt.status === "ok" && (receipt.new_suggestions || 0) > 0;
}

export async function deleteScheduledAnalyzeReceiptFiles(root: string, files: string[]): Promise<void> {
	if (!files.length) return;
	await withOwnedLock(root, "scheduled-receipts", async () => {
		const dir = pendingDir(root);
		for (const file of files) {
			if (basename(file) !== file || !RECEIPT_FILE_RE.test(file)) throw new Error("scheduled_receipt_invalid_filename");
			await rm(resolvePrivatePath(dir, file), { force: true });
		}
		await fsyncDirectory(dir);
	}, { waitMs: 2_000 });
}

export async function consumeScheduledAnalyzeReceipts(root: string, userId: string, notify: (message: string, level: "info" | "warn") => void | Promise<void>, options: { holdEligibleForBreakIn?: boolean } = {}): Promise<{ shown: boolean; deleted: number; held: ScheduledAnalyzeReceiptRecord[] }> {
	const pending = await readScheduledAnalyzeReceipts(root);
	const selected: ScheduledAnalyzeReceiptRecord[] = pending.receipts.map((receipt, index) => ({ receipt, file: pending.files[index] })).filter((item) => item.receipt.user_id === userId);
	const prompted = selected.filter((item) => item.receipt.break_in_delivery?.state === "prompted");
	const queued = options.holdEligibleForBreakIn ? selected.filter((item) => item.receipt.break_in_delivery?.state === "queued" && isScheduledAnalyzeBreakInEligible(item.receipt)) : [];
	const queuedWhileOff = options.holdEligibleForBreakIn ? [] : selected.filter((item) => item.receipt.break_in_delivery?.state === "queued");
	const freshHeld = options.holdEligibleForBreakIn ? selected.filter((item) => !item.receipt.break_in_delivery && isScheduledAnalyzeBreakInEligible(item.receipt)) : [];
	const excluded = new Set([...prompted, ...queued, ...queuedWhileOff, ...freshHeld].map((item) => item.file));
	const normal = selected.filter((item) => !excluded.has(item.file));
	const visible = [...normal, ...freshHeld];
	const message = formatScheduledAnalyzeReceiptSummary({ receipts: visible.map((item) => item.receipt), unreadable: pending.unreadable });
	if (message) {
		const level = visible.some((item) => item.receipt.severity === "warn") || pending.unreadable ? "warn" : "info";
		await notify(message, level);
	}
	const held: ScheduledAnalyzeReceiptRecord[] = [...queued];
	for (const item of freshHeld) {
		const queuedAt = new Date().toISOString();
		const transition = await transitionScheduledAnalyzeReceiptBreakInDelivery(root, {
			file: item.file,
			receiptId: item.receipt.id,
			userId,
			expected: "none",
			next: "queued",
			updatedAt: queuedAt,
		});
		if (transition === "updated") held.push({ ...item, receipt: { ...item.receipt, break_in_delivery: { state: "queued", updated_at: queuedAt } } });
	}
	const deleteFiles = [...normal, ...prompted, ...queuedWhileOff].map((item) => item.file);
	await deleteScheduledAnalyzeReceiptFiles(root, deleteFiles);
	return { shown: !!message, deleted: deleteFiles.length, held };
}

export const SCHEDULED_ANALYZE_RECEIPT_LIMIT = MAX_PENDING_RECEIPTS;
