export const MAX_CAPTURE_ASSISTANT_CHARS = 64 * 1024;
export const CAPTURE_ASSISTANT_TRUNCATION_MARKER = "[Agent Experience: earlier assistant output truncated]\n";

function textFromContent(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const item of content) {
			if (item && typeof item === "object" && (item as any).type === "text" && typeof (item as any).text === "string") {
				parts.push((item as any).text);
			}
			// Skip non-text blocks (ThinkingContent, ToolCall) instead of rejecting the message.
		}
		const joined = parts.join("\n");
		return joined.trim() === "" ? undefined : joined;
	}
	return undefined;
}

// A run whose TERMINAL assistant message ended in failure or truncation carries only
// partial/error/truncated output, never a usable final answer. "error"/"aborted" are
// failed runs; "length" is truncated mid-answer (rejected too — truncated text is a bad
// learning signal). Rejecting is run-level, not per-message: a tool-heavy failed run
// (assistant text + toolCall -> toolResult -> assistant stopReason "error") must drop its
// EARLIER same-run text as well, not just the final error message.
const REJECTED_TERMINAL_STOP_REASONS = new Set(["error", "aborted", "length"]);

export function extractSingleFinalAssistantText(messages: unknown[]): string | undefined {
	// AgentEndEvent.messages is RUN-SCOPED and its shape depends on the run type: the
	// INITIAL run (runAgentLoop) starts with the triggering user prompt(s) and then
	// appends this run's assistant messages and tool results; a CONTINUATION/retry run
	// (runAgentLoopContinue) starts empty and holds only that run's assistant messages,
	// tool results, and any mid-run steering user messages. We therefore read ONLY
	// assistant messages, which is correct for both shapes. Most coding runs are
	// tool-heavy and the final assistant message is often tool-only, so concatenating
	// every assistant message (rather than only the last) preserves the behavioral
	// signal. A mid-run steering user message already caused CapturePairBuffer to drop
	// the pair, and persistence is deferred to the settle boundary across retries, so
	// no user-boundary handling is needed here.
	const list = Array.isArray(messages) ? messages : [];
	// Run outcome = the stopReason of the LAST assistant message in the run. Reject the
	// whole run (collect nothing) when it terminated in failure/truncation, so the
	// buffer's keep-last-non-empty preserves a prior successful run and an exhausted
	// sequence of failed runs captures nothing.
	for (let i = list.length - 1; i >= 0; i -= 1) {
		const message = list[i];
		if (message && typeof message === "object" && (message as any).role === "assistant") {
			if (REJECTED_TERMINAL_STOP_REASONS.has((message as any).stopReason)) return undefined;
			break;
		}
	}
	const parts: string[] = [];
	for (const message of list) {
		if (!message || typeof message !== "object" || (message as any).role !== "assistant") continue;
		// Skip hidden assistant messages, consistent with visibleMessageText elsewhere.
		if ((message as any).display === false) continue;
		const text = textFromContent((message as any).content);
		if (typeof text === "string" && text.trim() !== "") parts.push(text);
	}
	if (parts.length === 0) return undefined;
	const joined = parts.join("\n");
	if (joined.length <= MAX_CAPTURE_ASSISTANT_CHARS) return joined;
	// Corrections and conclusions live at the end, so keep the TAIL and mark that
	// earlier output was truncated. Total length stays within the bound.
	const keep = Math.max(0, MAX_CAPTURE_ASSISTANT_CHARS - CAPTURE_ASSISTANT_TRUNCATION_MARKER.length);
	return CAPTURE_ASSISTANT_TRUNCATION_MARKER + joined.slice(joined.length - keep);
}
