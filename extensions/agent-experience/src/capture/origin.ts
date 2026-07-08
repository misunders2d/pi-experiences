import { normalizeUserId } from "../storage/private-root.ts";

export const MAX_CAPTURE_INPUT_CHARS = 16 * 1024;

export interface CaptureKey {
	sessionId: string;
	sessionFile: string;
	userId: string;
}

export interface CaptureInputCandidate {
	text: string;
	images?: unknown[];
	source?: string;
	streamingBehavior?: string;
	sessionId?: string;
	sessionFile?: string;
	userId?: string;
}

export type OriginDecision =
	| { allow: true; key: CaptureKey; text: string; origin: { source: "local_interactive" } }
	| { allow: false; key?: CaptureKey; reason: string };

function maybeKey(input: CaptureInputCandidate): CaptureKey | undefined {
	try {
		if (!input.sessionId || !input.sessionFile) return undefined;
		return { sessionId: String(input.sessionId), sessionFile: String(input.sessionFile), userId: normalizeUserId(input.userId) };
	} catch {
		return undefined;
	}
}

export function keyToString(key: CaptureKey): string {
	return `${key.userId}\u001f${key.sessionId}\u001f${key.sessionFile}`;
}

export function classifyCaptureInput(input: CaptureInputCandidate): OriginDecision {
	const key = maybeKey(input);
	if (input.source !== "interactive") return { allow: false, key, reason: "source_not_allowlisted" };
	if (input.streamingBehavior) return { allow: false, key, reason: "streaming_input_denied" };
	if (input.images && input.images.length > 0) return { allow: false, key, reason: "images_denied" };
	if (!key) return { allow: false, reason: "missing_capture_key" };
	if (typeof input.text !== "string" || input.text.trim() === "") return { allow: false, key, reason: "empty_text_denied" };
	if (input.text.length > MAX_CAPTURE_INPUT_CHARS) return { allow: false, key, reason: "input_too_large" };
	return { allow: true, key, text: input.text, origin: { source: "local_interactive" } };
}
