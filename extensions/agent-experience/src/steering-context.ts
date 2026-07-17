import { containsUnredactedSensitiveText, redactText } from "./storage/redaction.ts";

export const MAX_STEERING_CONTEXT_MESSAGES = 4;
export const MAX_STEERING_CONTEXT_MESSAGE_CHARS = 300;
export const MAX_STEERING_CONTEXT_TOTAL_CHARS = 1200;

export interface SteeringContextTurn {
	role: "user" | "assistant";
	text: string;
}

export interface LatestUserMessageBoundary {
	index: number;
	count: number;
	text: string;
}

export function visibleMessageText(message: any): string {
	if (!message || message.display === false) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("");
}

export function latestUserMessageBoundary(messages: unknown[]): LatestUserMessageBoundary | undefined {
	let index = -1;
	let count = 0;
	for (let offset = 0; offset < messages.length; offset += 1) {
		const message = messages[offset] as any;
		if (message?.role !== "user") continue;
		count += 1;
		index = offset;
	}
	if (index < 0) return undefined;
	return { index, count, text: visibleMessageText(messages[index]) };
}

function boundedContextText(value: string): string {
	const text = redactText(value)
		.trim()
		.replace(/\s+/g, " ")
		.slice(0, MAX_STEERING_CONTEXT_MESSAGE_CHARS);
	if (containsUnredactedSensitiveText(text)) throw new Error("steering_context_sensitive_text");
	return text;
}

export function extractSteeringContext(messages: unknown[], currentUserIndex: number): SteeringContextTurn[] {
	if (!Array.isArray(messages) || !Number.isInteger(currentUserIndex) || currentUserIndex < 0 || currentUserIndex >= messages.length) {
		throw new Error("steering_context_boundary_invalid");
	}
	if ((messages[currentUserIndex] as any)?.role !== "user") throw new Error("steering_context_boundary_invalid");
	const eligible: SteeringContextTurn[] = [];
	for (let index = 0; index < currentUserIndex; index += 1) {
		const message = messages[index] as any;
		if (message?.display === false || (message?.role !== "user" && message?.role !== "assistant")) continue;
		const text = boundedContextText(visibleMessageText(message));
		if (!text) continue;
		eligible.push({ role: message.role, text });
	}
	const selected = eligible.slice(-MAX_STEERING_CONTEXT_MESSAGES);
	if (selected.reduce((total, turn) => total + turn.text.length, 0) > MAX_STEERING_CONTEXT_TOTAL_CHARS) {
		throw new Error("steering_context_too_large");
	}
	return selected;
}
