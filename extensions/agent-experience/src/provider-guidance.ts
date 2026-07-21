const GUIDANCE_OPEN = "<agent_experience_response_guidance>";
const GUIDANCE_CLOSE = "</agent_experience_response_guidance>";
const MAX_GUIDANCE_CHARS = 10_000;

export const KNOWN_GUIDANCE_APIS = [
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-vertex",
	"mistral-conversations",
	"pi-messages",
] as const;

export type KnownGuidanceApi = typeof KNOWN_GUIDANCE_APIS[number];
export type ProviderGuidanceFailureReason = "invalid_guidance" | "unsupported_api" | "known_api_shape_mismatch" | "conflicting_guidance";
export type ProviderGuidanceResult =
	| { ok: true; payload: unknown; changed: boolean }
	| { ok: false; reason: ProviderGuidanceFailureReason };

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function guidanceBlock(guidance: unknown): string | undefined {
	if (typeof guidance !== "string") return undefined;
	const value = guidance.trim();
	if (!value || value.length > MAX_GUIDANCE_CHARS || value.includes(GUIDANCE_OPEN) || value.includes(GUIDANCE_CLOSE)) return undefined;
	return `\n\n${GUIDANCE_OPEN}\n${value}\n${GUIDANCE_CLOSE}`;
}

function appendString(value: unknown, block: string): { ok: true; value: string; changed: boolean } | { ok: false; conflict: boolean } {
	if (typeof value !== "string" || !value) return { ok: false, conflict: false };
	if (value.includes(block)) return { ok: true, value, changed: false };
	if (value.includes(GUIDANCE_OPEN) || value.includes(GUIDANCE_CLOSE)) return { ok: false, conflict: true };
	return { ok: true, value: `${value}${block}`, changed: true };
}

function appendRoleArray(payload: RecordValue, key: "messages" | "input", block: string): ProviderGuidanceResult {
	const rows = payload[key];
	if (!Array.isArray(rows)) return { ok: false, reason: "known_api_shape_mismatch" };
	const matches = rows
		.map((row, index) => ({ row, index }))
		.filter(({ row }) => isRecord(row) && (row.role === "system" || row.role === "developer") && typeof row.content === "string");
	if (matches.length !== 1) return { ok: false, reason: "known_api_shape_mismatch" };
	const { row, index } = matches[0] as { row: RecordValue; index: number };
	const appended = appendString(row.content, block);
	if (!appended.ok) return { ok: false, reason: appended.conflict ? "conflicting_guidance" : "known_api_shape_mismatch" };
	if (!appended.changed) return { ok: true, payload, changed: false };
	const nextRows = rows.slice();
	nextRows[index] = { ...row, content: appended.value };
	return { ok: true, payload: { ...payload, [key]: nextRows }, changed: true };
}

function structuredSystemAlreadyContains(system: unknown[], block: string): "same" | "conflict" | "absent" {
	// Structured Anthropic/Bedrock system entries store the framing block without
	// the leading separator used when appending to an existing string field.
	for (const item of system) {
		if (!isRecord(item) || typeof item.text !== "string") continue;
		if (item.text.includes(block.trimStart())) return "same";
		if (item.text.includes(GUIDANCE_OPEN) || item.text.includes(GUIDANCE_CLOSE)) return "conflict";
	}
	return "absent";
}

export function appendHabitGuidanceToProviderPayload(api: unknown, payload: unknown, guidance: unknown): ProviderGuidanceResult {
	const block = guidanceBlock(guidance);
	if (!block) return { ok: false, reason: "invalid_guidance" };
	if (!KNOWN_GUIDANCE_APIS.includes(api as KnownGuidanceApi)) return { ok: false, reason: "unsupported_api" };
	if (!isRecord(payload)) return { ok: false, reason: "known_api_shape_mismatch" };

	switch (api as KnownGuidanceApi) {
	case "openai-completions":
	case "mistral-conversations":
		return appendRoleArray(payload, "messages", block);
	case "openai-responses":
	case "azure-openai-responses":
		return appendRoleArray(payload, "input", block);
	case "openai-codex-responses": {
		const appended = appendString(payload.instructions, block);
		if (!appended.ok) return { ok: false, reason: appended.conflict ? "conflicting_guidance" : "known_api_shape_mismatch" };
		return appended.changed ? { ok: true, payload: { ...payload, instructions: appended.value }, changed: true } : { ok: true, payload, changed: false };
	}
	case "anthropic-messages": {
		if (!Array.isArray(payload.system)) return { ok: false, reason: "known_api_shape_mismatch" };
		const existing = structuredSystemAlreadyContains(payload.system, block);
		if (existing === "conflict") return { ok: false, reason: "conflicting_guidance" };
		if (existing === "same") return { ok: true, payload, changed: false };
		return { ok: true, payload: { ...payload, system: [...payload.system, { type: "text", text: block.trimStart() }] }, changed: true };
	}
	case "bedrock-converse-stream": {
		if (!Array.isArray(payload.system)) return { ok: false, reason: "known_api_shape_mismatch" };
		const existing = structuredSystemAlreadyContains(payload.system, block);
		if (existing === "conflict") return { ok: false, reason: "conflicting_guidance" };
		if (existing === "same") return { ok: true, payload, changed: false };
		return { ok: true, payload: { ...payload, system: [...payload.system, { text: block.trimStart() }] }, changed: true };
	}
	case "google-generative-ai":
	case "google-vertex": {
		if (!isRecord(payload.config)) return { ok: false, reason: "known_api_shape_mismatch" };
		const appended = appendString(payload.config.systemInstruction, block);
		if (!appended.ok) return { ok: false, reason: appended.conflict ? "conflicting_guidance" : "known_api_shape_mismatch" };
		return appended.changed
			? { ok: true, payload: { ...payload, config: { ...payload.config, systemInstruction: appended.value } }, changed: true }
			: { ok: true, payload, changed: false };
	}
	case "pi-messages": {
		if (!isRecord(payload.context)) return { ok: false, reason: "known_api_shape_mismatch" };
		const appended = appendString(payload.context.systemPrompt, block);
		if (!appended.ok) return { ok: false, reason: appended.conflict ? "conflicting_guidance" : "known_api_shape_mismatch" };
		return appended.changed
			? { ok: true, payload: { ...payload, context: { ...payload.context, systemPrompt: appended.value } }, changed: true }
			: { ok: true, payload, changed: false };
	}
	}
}
