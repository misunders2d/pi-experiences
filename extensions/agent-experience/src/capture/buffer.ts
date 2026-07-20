import { keyToString, type CaptureKey } from "./origin.ts";

export const MAX_CAPTURE_STATES = 16;

export type CloseReason = "agent_settled" | "next_input" | "session_shutdown" | "disable";

export interface PendingInput {
	key: CaptureKey;
	text: string;
	origin: { source: "local_interactive" };
	createdAt: string;
}

export interface CompletedPair {
	key: CaptureKey;
	origin: { source: "local_interactive" };
	userText: string;
	assistantText: string;
	inputCreatedAt: string;
	completedAt: string;
}

// "pending": user input received, no assistant text yet.
// "settling": at least one agent_end produced assistant text; awaiting the settle
// boundary. Pi's automatic retries emit multiple agent_end events for one prompt
// (an initial run then continuations), so persistence is deferred until settle and
// the assistant text is the LAST non-empty run — the final corrected answer, not a
// retryable partial/error run.
type CaptureState =
	| { state: "pending"; input: PendingInput }
	| { state: "settling"; input: PendingInput; assistantText: string; completedAt: string };

export interface PairPayload {
	kind: "conversation_pair_v1";
	close_reason: CloseReason;
	user_text_redacted: string;
	assistant_text_redacted: string;
	user_char_count: number;
	assistant_char_count: number;
	input_created_at: string;
	completed_at: string;
}

export type AppendPair = (pair: CompletedPair, reason: CloseReason) => Promise<void>;

function pairFromSettling(state: { input: PendingInput; assistantText: string; completedAt: string }): CompletedPair {
	return {
		key: state.input.key,
		origin: state.input.origin,
		userText: state.input.text,
		assistantText: state.assistantText,
		inputCreatedAt: state.input.createdAt,
		completedAt: state.completedAt,
	};
}

export class CapturePairBuffer {
	private states = new Map<string, CaptureState>();
	private readonly maxStates: number;

	constructor(maxStates = MAX_CAPTURE_STATES) {
		this.maxStates = maxStates;
	}

	private enforceBound(): void {
		if (this.states.size > this.maxStates) this.states.clear();
	}

	async acceptInput(input: PendingInput, append: AppendPair): Promise<void> {
		const key = keyToString(input.key);
		const current = this.states.get(key);
		if (!current) {
			this.states.set(key, { state: "pending", input });
			this.enforceBound();
			return;
		}
		if (current.state === "settling") {
			// A new user turn arrived before the prior pair settled; flush it as a backstop.
			try {
				await append(pairFromSettling(current), "next_input");
				this.states.set(key, { state: "pending", input });
				this.enforceBound();
			} catch {
				this.states.delete(key);
				throw new Error("Agent Experience capture append failed");
			}
			return;
		}
		// A second user input before any agent_end means correlation is ambiguous; drop memory only.
		this.states.delete(key);
	}

	// Record an agent_end without persisting. Pi may emit several agent_end events for
	// one settled prompt (retryable error/partial run, then a continuation with the
	// real answer). Keep the LAST non-empty assistant text; an empty run (tool-only or
	// error with no text) must not overwrite or drop an already-captured answer.
	recordAgentEnd(key: CaptureKey, assistantText: string | undefined, completedAt = new Date().toISOString()): void {
		const keyString = keyToString(key);
		const current = this.states.get(keyString);
		if (!current) return;
		if (!assistantText) return;
		this.states.set(keyString, { state: "settling", input: current.input, assistantText, completedAt });
	}

	// Persist the settled pair at the true settle boundary (after all retries). A
	// pending state with no assistant text is dropped (nothing to save).
	async settle(key: CaptureKey, append: AppendPair): Promise<void> {
		const keyString = keyToString(key);
		const current = this.states.get(keyString);
		if (!current) return;
		this.states.delete(keyString);
		if (current.state !== "settling") return;
		await append(pairFromSettling(current), "agent_settled");
	}

	dropKey(key: CaptureKey | undefined): void {
		if (key) this.states.delete(keyToString(key));
	}

	clearAll(): void {
		this.states.clear();
	}

	// Backstop flush (session shutdown) if settle never fired.
	async flushKey(key: CaptureKey, reason: CloseReason, append: AppendPair): Promise<void> {
		const keyString = keyToString(key);
		const current = this.states.get(keyString);
		this.states.delete(keyString);
		if (!current || current.state !== "settling") return;
		await append(pairFromSettling(current), reason);
	}

	stateForTest(key: CaptureKey): string | undefined {
		return this.states.get(keyToString(key))?.state;
	}

	sizeForTest(): number {
		return this.states.size;
	}
}

export function buildPairPayload(pair: CompletedPair, reason: CloseReason): PairPayload {
	return {
		kind: "conversation_pair_v1",
		close_reason: reason,
		user_text_redacted: pair.userText,
		assistant_text_redacted: pair.assistantText,
		user_char_count: pair.userText.length,
		assistant_char_count: pair.assistantText.length,
		input_created_at: pair.inputCreatedAt,
		completed_at: pair.completedAt,
	};
}
