export const MAX_CAPTURE_ASSISTANT_CHARS = 64 * 1024;

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

export function extractSingleFinalAssistantText(messages: unknown[]): string | undefined {
	// AgentEndEvent.messages is the full conversation. Use only the last assistant
	// message for this turn; do not walk back to older assistant text if the final
	// assistant message was tool-only/aborted/oversized.
	for (let i = (messages || []).length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message || typeof message !== "object") continue;
		const m = message as any;
		if (m.role !== "assistant") continue;
		const text = textFromContent(m.content);
		if (typeof text !== "string" || text.trim() === "") return undefined;
		if (text.length > MAX_CAPTURE_ASSISTANT_CHARS) return undefined;
		return text;
	}
	return undefined;
}
