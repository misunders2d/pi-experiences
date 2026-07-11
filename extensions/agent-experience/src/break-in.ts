export type BreakInOrigin = "manual" | "scheduled";

export interface BreakInScope {
	userId: string;
	sessionId: string;
	sessionFile: string;
}

export interface PendingBreakInBatch {
	origin: BreakInOrigin;
	batchId: string;
	scope: BreakInScope;
	suggestionCount: number;
	createdAt: number;
	expiresAt: number;
	receipt?: { file: string; id: string };
}

const MAX_PENDING_BREAK_IN_BATCHES = 20;
const BREAK_IN_TTL_MS = 2 * 60 * 60_000;
const SAFE_BATCH_ID = /^[A-Za-z0-9._:-]{1,200}$/;

export function breakInScopeKey(scope: BreakInScope): string {
	return `${scope.userId}\u0000${scope.sessionId}\u0000${scope.sessionFile}`;
}

function validateScope(scope: BreakInScope): BreakInScope {
	for (const value of [scope.userId, scope.sessionId, scope.sessionFile]) {
		if (typeof value !== "string" || !value || value.length > 1000 || value.includes("\0")) throw new Error("break_in_scope_invalid");
	}
	return { ...scope };
}

function validateReceipt(value: PendingBreakInBatch["receipt"]): PendingBreakInBatch["receipt"] {
	if (!value) return undefined;
	if (typeof value.file !== "string" || !/^\d{17}-[0-9a-f-]{36}\.json$/i.test(value.file)) throw new Error("break_in_receipt_invalid");
	if (typeof value.id !== "string" || !/^[0-9a-f-]{36}$/i.test(value.id)) throw new Error("break_in_receipt_invalid");
	return { file: value.file, id: value.id };
}

export class BreakInQueue {
	private readonly batches = new Map<string, PendingBreakInBatch>();

	private purge(now = Date.now()): void {
		for (const [key, batch] of this.batches) if (batch.expiresAt <= now) this.batches.delete(key);
	}

	enqueue(input: { origin: BreakInOrigin; batchId: string; scope: BreakInScope; suggestionCount: number; receipt?: PendingBreakInBatch["receipt"]; now?: number }): { queued: boolean; overflowed: boolean } {
		const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
		this.purge(now);
		if (!SAFE_BATCH_ID.test(input.batchId)) throw new Error("break_in_batch_id_invalid");
		const scope = validateScope(input.scope);
		const key = `${breakInScopeKey(scope)}\u0000${input.batchId}`;
		if (this.batches.has(key)) return { queued: false, overflowed: false };
		const suggestionCount = Number.isInteger(input.suggestionCount) ? Math.max(1, Math.min(1_000_000, input.suggestionCount)) : 1;
		let overflowed = false;
		if (this.batches.size >= MAX_PENDING_BREAK_IN_BATCHES) {
			const oldest = [...this.batches.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
			if (oldest) this.batches.delete(oldest[0]);
			overflowed = true;
		}
		this.batches.set(key, {
			origin: input.origin,
			batchId: input.batchId,
			scope,
			suggestionCount,
			createdAt: now,
			expiresAt: now + BREAK_IN_TTL_MS,
			receipt: validateReceipt(input.receipt),
		});
		return { queued: true, overflowed };
	}

	peek(scope: BreakInScope, now = Date.now()): PendingBreakInBatch | undefined {
		this.purge(now);
		const prefix = `${breakInScopeKey(validateScope(scope))}\u0000`;
		return [...this.batches.entries()].filter(([key]) => key.startsWith(prefix)).sort((a, b) => a[1].createdAt - b[1].createdAt)[0]?.[1];
	}

	remove(batch: PendingBreakInBatch): boolean {
		return this.batches.delete(`${breakInScopeKey(batch.scope)}\u0000${batch.batchId}`);
	}

	cancelScope(scope: BreakInScope): number {
		const prefix = `${breakInScopeKey(validateScope(scope))}\u0000`;
		let removed = 0;
		for (const key of this.batches.keys()) if (key.startsWith(prefix)) { this.batches.delete(key); removed += 1; }
		return removed;
	}

	clear(): void { this.batches.clear(); }
	size(now = Date.now()): number { this.purge(now); return this.batches.size; }
}

export const BREAK_IN_QUEUE_LIMIT = MAX_PENDING_BREAK_IN_BATCHES;
export const BREAK_IN_BATCH_TTL_MS = BREAK_IN_TTL_MS;
