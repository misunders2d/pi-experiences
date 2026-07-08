import { keyToString, type CaptureKey } from "./origin.ts";

export const MAX_CAPTURE_STATES = 16;

export type CloseReason = "agent_end" | "next_input" | "session_shutdown" | "disable";

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

type CaptureState =
	| { state: "pending"; input: PendingInput }
	| { state: "complete"; pair: CompletedPair };

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
		if (current.state === "complete") {
			try {
				await append(current.pair, "next_input");
				this.states.set(key, { state: "pending", input });
				this.enforceBound();
			} catch {
				this.states.delete(key);
				throw new Error("Agent Experience capture append failed");
			}
			return;
		}
		// A second user input before agent_end means correlation is ambiguous; drop memory only.
		this.states.delete(key);
	}

	completeAgentEnd(key: CaptureKey, assistantText: string, completedAt = new Date().toISOString()): void {
		const keyString = keyToString(key);
		const current = this.states.get(keyString);
		if (!current || current.state !== "pending") {
			this.states.delete(keyString);
			return;
		}
		this.states.set(keyString, {
			state: "complete",
			pair: {
				key,
				origin: current.input.origin,
				userText: current.input.text,
				assistantText,
				inputCreatedAt: current.input.createdAt,
				completedAt,
			},
		});
	}

	dropKey(key: CaptureKey | undefined): void {
		if (key) this.states.delete(keyToString(key));
	}

	clearAll(): void {
		this.states.clear();
	}

	async flushKey(key: CaptureKey, reason: CloseReason, append: AppendPair): Promise<void> {
		const keyString = keyToString(key);
		const current = this.states.get(keyString);
		this.states.delete(keyString);
		if (!current || current.state !== "complete") return;
		await append(current.pair, reason);
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
