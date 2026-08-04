import { createHash } from "node:crypto";
import { containsUnredactedSensitiveText, redactText } from "../storage/redaction.ts";
import type { AdvisorPrimaryDelta, AdvisorScope } from "./types.ts";

const MAX_DELTA_CHARS = 24_000;
const MAX_TOOL_EVENTS = 8;

interface ContentBlock {
	type: string;
	[key: string]: unknown;
}

interface AssistantMessage {
	role: "assistant";
	content: ContentBlock[];
}

interface ToolResult {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: ContentBlock[];
	isError: boolean;
}

export interface AdvisorTurnContext {
	scope: AdvisorScope;
	epoch: number;
	generation: number;
	cursor: number;
	currentUserEntryId: string;
	primaryEntryIds: string[];
	causalEpisodeId: string;
	causedByAdvisor: boolean;
	currentRequest: string;
	assistantMessage: AssistantMessage;
	toolResults: ToolResult[];
}

function extractText(block: ContentBlock): string {
	if (block.type === "text" && typeof block.text === "string") return block.text;
	if (block.type === "thinking" && typeof block.thinking === "string") return block.thinking;
	if (block.type === "toolCall") {
		const name = typeof block.name === "string" ? block.name : "tool";
		const args = block.arguments ? JSON.stringify(block.arguments) : "";
		return `[tool_call:${name}] ${args}`;
	}
	return "";
}

function extractToolResultText(result: ToolResult): string {
	const content = result.content.map((block) => {
		if (block.type === "text" && typeof block.text === "string") return block.text;
		return "";
	}).join("\n");
	const prefix = result.isError ? "[tool_error:" : "[tool_result:";
	return `${prefix}${result.toolName}] ${content}`;
}

function countToolEvents(blocks: ContentBlock[]): number {
	let count = 0;
	for (const block of blocks) {
		if (block.type === "toolCall") count++;
	}
	return count;
}

export function extractAdvisorTurnDelta(input: AdvisorTurnContext): AdvisorPrimaryDelta | undefined {
	// No delta for Advisor-caused generation
	if (input.causedByAdvisor) return undefined;

	// Empty assistant turn
	const message = input.assistantMessage;
	if (!message || message.role !== "assistant") return undefined;

	const content = Array.isArray(message.content) ? message.content : [];
	if (content.length === 0) return undefined;

	// Check for Advisor/Experience custom message (blocks with non-standard types)
	for (const block of content) {
		const blockType = block?.type;
		if (blockType && blockType !== "text" && blockType !== "thinking" && blockType !== "toolCall") {
			return undefined;
		}
	}

	// Validate stable entry identity
	if (typeof input.currentUserEntryId !== "string" || !input.currentUserEntryId) return undefined;
	if (!Array.isArray(input.primaryEntryIds) || input.primaryEntryIds.length === 0) return undefined;
	for (const id of input.primaryEntryIds) {
		if (typeof id !== "string" || !id) return undefined;
	}

	// Count tool events (tool calls only; results are included in text), cap at MAX_TOOL_EVENTS
	const totalToolEvents = countToolEvents(content);
	const cappedToolCount = Math.min(totalToolEvents, MAX_TOOL_EVENTS);

	// Extract text
	const parts: string[] = [];

	// Current request
	if (typeof input.currentRequest === "string" && input.currentRequest.trim()) {
		parts.push(`Request: ${input.currentRequest.trim()}`);
	}

	// Assistant message content
	for (const block of content) {
		const text = extractText(block);
		if (text) parts.push(text);
	}

	// Tool results (capped)
	const results = Array.isArray(input.toolResults) ? input.toolResults.slice(0, MAX_TOOL_EVENTS) : [];
	for (const result of results) {
		const text = extractToolResultText(result);
		if (text) parts.push(text);
	}

	let rawText = parts.join("\n");

	// Redact
	rawText = redactText(rawText);
	if (containsUnredactedSensitiveText(rawText)) return undefined;

	// Cap at MAX_DELTA_CHARS
	if (rawText.length > MAX_DELTA_CHARS) {
		rawText = rawText.slice(0, MAX_DELTA_CHARS);
	}

	// Compute SHA-256 fingerprint over scope, entry IDs, causal episode, and redacted content
	const fingerprint = computeEventFingerprint(
		input.scope,
		input.primaryEntryIds,
		input.causalEpisodeId,
		rawText,
	);

	return {
		scope: input.scope,
		epoch: input.epoch,
		generation: input.generation,
		cursor: input.cursor,
		currentUserEntryId: input.currentUserEntryId,
		primaryEntryIds: input.primaryEntryIds,
		causalEpisodeId: input.causalEpisodeId,
		causedByAdvisor: false,
		text: rawText,
		currentRequest: input.currentRequest,
		inProgress: false,
		toolEventCount: cappedToolCount,
		eventFingerprint: fingerprint,
	};
}

export function computeEventFingerprint(
	scope: AdvisorScope,
	entryIds: string[],
	causalEpisodeId: string,
	redactedContent: string,
): string {
	const hash = createHash("sha256");
	hash.update(`session:${scope.userId}:${scope.sessionId}:${scope.sessionFile}`);
	hash.update("|");
	hash.update(`entries:${entryIds.join(",")}`);
	hash.update("|");
	hash.update(`episode:${causalEpisodeId}`);
	hash.update("|");
	hash.update(`content:${redactedContent}`);
	return hash.digest("hex");
}
