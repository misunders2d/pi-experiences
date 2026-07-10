import { randomUUID } from "node:crypto";
import { keyToString, type CaptureKey } from "./capture/origin.ts";

export const CONVERSATION_STATE_TTL_MS = 15 * 60 * 1_000;
export const CONVERSATION_STATE_MAX_SCOPES = 128;
export const CONVERSATION_REVIEW_MAX_ITEMS = 20;

export type ConversationalHabitPolarity = 1 | -1;

export interface ConversationalHabitDraft {
	declarationId: string;
	condition: string;
	behavior: string;
	polarity: ConversationalHabitPolarity;
	createdTurn: number;
	createdAtMs: number;
	expiresAtMs: number;
	confirming: boolean;
	completed?: { result: SanitizedDeclarationResult };
}

export interface SanitizedDeclarationResult {
	outcome: "active" | "duplicate_review" | "law_blocked" | "conflict_blocked" | "not_saved";
	message: string;
}

export type ConversationalReviewMapping =
	| { kind: "candidate"; type: "candidate" | "pending_review"; id: string; checksum: string }
	| { kind: "duplicate"; id: string; checksum: string; expectedHabitChecksums: Record<string, string> };

interface ReviewSnapshot {
	items: ConversationalReviewMapping[];
	createdTurn: number;
	createdAtMs: number;
	expiresAtMs: number;
	applying: boolean;
}

interface ScopeState {
	turn: number;
	lastTouchedMs: number;
	draft?: ConversationalHabitDraft;
	review?: ReviewSnapshot;
}

export type ConversationStateErrorCode = "missing_scope" | "missing_draft" | "expired" | "confirmation_required" | "next_turn_required" | "busy" | "missing_snapshot" | "invalid_item";

export class ConversationStateError extends Error {
	readonly code: ConversationStateErrorCode;

	constructor(code: ConversationStateErrorCode) {
		super(code);
		this.code = code;
	}
}

export class AgentExperienceConversationState {
	private readonly scopes = new Map<string, ScopeState>();
	private readonly options: { now?: () => number; randomId?: () => string; ttlMs?: number; maxScopes?: number };

	constructor(options: { now?: () => number; randomId?: () => string; ttlMs?: number; maxScopes?: number } = {}) {
		this.options = options;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private ttlMs(): number {
		return Math.max(1_000, this.options.ttlMs ?? CONVERSATION_STATE_TTL_MS);
	}

	private scopeKey(key: CaptureKey): string {
		if (!key.sessionId || !key.sessionFile || !key.userId) throw new ConversationStateError("missing_scope");
		return keyToString(key);
	}

	private prune(now = this.now()): void {
		for (const [key, state] of this.scopes) {
			if (state.draft && state.draft.expiresAtMs <= now) state.draft = undefined;
			if (state.review && state.review.expiresAtMs <= now) state.review = undefined;
			if (!state.draft && !state.review && now - state.lastTouchedMs > this.ttlMs()) this.scopes.delete(key);
		}
		const maxScopes = Math.max(1, this.options.maxScopes ?? CONVERSATION_STATE_MAX_SCOPES);
		if (this.scopes.size <= maxScopes) return;
		const oldest = [...this.scopes.entries()].sort((left, right) => left[1].lastTouchedMs - right[1].lastTouchedMs);
		for (const [key] of oldest.slice(0, this.scopes.size - maxScopes)) this.scopes.delete(key);
	}

	private getScope(key: CaptureKey, create = true): ScopeState | undefined {
		const now = this.now();
		this.prune(now);
		const id = this.scopeKey(key);
		let state = this.scopes.get(id);
		if (!state && create) {
			state = { turn: 0, lastTouchedMs: now };
			this.scopes.set(id, state);
			this.prune(now);
		}
		if (state) state.lastTouchedMs = now;
		return state;
	}

	noteUserInput(key: CaptureKey): number {
		const state = this.getScope(key)!;
		state.turn += 1;
		return state.turn;
	}

	putDraft(key: CaptureKey, input: { condition: string; behavior: string; polarity: ConversationalHabitPolarity }): ConversationalHabitDraft {
		const state = this.getScope(key)!;
		const now = this.now();
		const draft: ConversationalHabitDraft = {
			declarationId: (this.options.randomId?.() ?? randomUUID()).replace(/[^A-Za-z0-9_-]/g, "_"),
			condition: input.condition,
			behavior: input.behavior,
			polarity: input.polarity,
			createdTurn: state.turn,
			createdAtMs: now,
			expiresAtMs: now + this.ttlMs(),
			confirming: false,
		};
		state.draft = draft;
		return draft;
	}

	beginConfirmation(key: CaptureKey, confirmed: boolean): { draft: ConversationalHabitDraft; completed?: SanitizedDeclarationResult } {
		if (!confirmed) throw new ConversationStateError("confirmation_required");
		const state = this.getScope(key, false);
		if (!state?.draft) throw new ConversationStateError("missing_draft");
		const now = this.now();
		if (state.draft.expiresAtMs <= now) {
			state.draft = undefined;
			throw new ConversationStateError("expired");
		}
		if (state.draft.completed) return { draft: state.draft, completed: state.draft.completed.result };
		if (state.turn <= state.draft.createdTurn) throw new ConversationStateError("next_turn_required");
		if (state.draft.confirming) throw new ConversationStateError("busy");
		state.draft.confirming = true;
		return { draft: state.draft };
	}

	completeConfirmation(key: CaptureKey, declarationId: string, result: SanitizedDeclarationResult): void {
		const state = this.getScope(key, false);
		if (!state?.draft || state.draft.declarationId !== declarationId) throw new ConversationStateError("missing_draft");
		state.draft.confirming = false;
		state.draft.completed = { result };
	}

	failConfirmation(key: CaptureKey, declarationId: string): void {
		const state = this.getScope(key, false);
		if (state?.draft?.declarationId === declarationId) state.draft.confirming = false;
	}

	putReviewSnapshot(key: CaptureKey, items: ConversationalReviewMapping[]): void {
		const state = this.getScope(key)!;
		const now = this.now();
		state.review = {
			items: items.slice(0, CONVERSATION_REVIEW_MAX_ITEMS),
			createdTurn: state.turn,
			createdAtMs: now,
			expiresAtMs: now + this.ttlMs(),
			applying: false,
		};
	}

	beginReviewAction(key: CaptureKey, itemNumber: number, confirmed: boolean): ConversationalReviewMapping {
		if (!confirmed) throw new ConversationStateError("confirmation_required");
		const state = this.getScope(key, false);
		if (!state?.review) throw new ConversationStateError("missing_snapshot");
		const now = this.now();
		if (state.review.expiresAtMs <= now) {
			state.review = undefined;
			throw new ConversationStateError("expired");
		}
		if (state.turn <= state.review.createdTurn) throw new ConversationStateError("next_turn_required");
		if (state.review.applying) throw new ConversationStateError("busy");
		const item = state.review.items[itemNumber - 1];
		if (!item) throw new ConversationStateError("invalid_item");
		state.review.applying = true;
		return item;
	}

	completeReviewAction(key: CaptureKey): void {
		const state = this.getScope(key, false);
		if (state) state.review = undefined;
	}

	failReviewAction(key: CaptureKey, stale = false): void {
		const state = this.getScope(key, false);
		if (!state?.review) return;
		if (stale) state.review = undefined;
		else state.review.applying = false;
	}
}
