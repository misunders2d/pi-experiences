import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Tokenizer } from "@huggingface/tokenizers";
import { containsUnredactedSensitiveText, redactText } from "../storage/redaction.ts";
import { LOCAL_EMBEDDING_MAX_TOKENS } from "../semantic/local-model-manifest.ts";
import type { AdvisorPrimaryDelta } from "./types.ts";

const MAX_TOOL_SPANS = 8;
const MAX_TOOL_NAME_CHARS = 120;
const MAX_TOOL_PAYLOAD_CHARS = 1_200;
const MAX_ASSISTANT_EDGE_CHARS = 1_200;
const TOOL_EVENT = /\[tool_(call|result|error):([^\]\r\n]{1,120})\]\s*([\s\S]*?)(?=\[tool_(?:call|result|error):|$)/gi;

let cachedTokenizer: { assetDir: string; tokenizer: Tokenizer } | undefined;

function compact(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function boundedEdges(value: string, max: number): string {
	if (value.length <= max) return value;
	const head = Math.floor(max / 2);
	return `${value.slice(0, head)} ${value.slice(value.length - (max - head))}`;
}

async function loadConfiguredTokenizer(assetDir: string): Promise<Tokenizer> {
	const canonicalAssetDir = resolve(assetDir);
	if (cachedTokenizer?.assetDir === canonicalAssetDir) return cachedTokenizer.tokenizer;
	const [tokenizerSource, configSource] = await Promise.all([
		readFile(resolve(canonicalAssetDir, "tokenizer.json"), "utf8"),
		readFile(resolve(canonicalAssetDir, "tokenizer_config.json"), "utf8"),
	]);
	const tokenizer = new Tokenizer(JSON.parse(tokenizerSource), JSON.parse(configSource));
	cachedTokenizer = { assetDir: canonicalAssetDir, tokenizer };
	return tokenizer;
}

function prioritizedBehaviorSource(delta: AdvisorPrimaryDelta): string {
	const raw = String(delta.text ?? "");
	const bounded = raw.length <= 24_000 ? raw : `${raw.slice(0, 12_000)} ${raw.slice(-12_000)}`;
	const safe = redactText(bounded);
	if (containsUnredactedSensitiveText(safe)) throw new Error("advisor_retrieval_query_not_redacted");
	const toolSpans: Array<{ start: number; end: number; text: string }> = [];
	for (const match of safe.matchAll(TOOL_EVENT)) {
		const start = match.index;
		if (start === undefined) continue;
		const name = compact(match[2]).slice(0, MAX_TOOL_NAME_CHARS);
		const payload = boundedEdges(compact(match[3]), MAX_TOOL_PAYLOAD_CHARS);
		toolSpans.push({ start, end: start + match[0].length, text: compact(`tool ${match[1]} ${name} ${payload}`) });
	}
	const selectedTools = toolSpans.slice(-MAX_TOOL_SPANS).reverse();
	let assistant = safe;
	for (const span of [...toolSpans].reverse()) assistant = `${assistant.slice(0, span.start)} ${assistant.slice(span.end)}`;
	assistant = compact(assistant.replace(/(?:^|\s)Request:\s*[^\n]*/gi, " "));
	const assistantTail = boundedEdges(assistant.slice(-MAX_ASSISTANT_EDGE_CHARS), MAX_ASSISTANT_EDGE_CHARS);
	const assistantHead = boundedEdges(assistant.slice(0, MAX_ASSISTANT_EDGE_CHARS), MAX_ASSISTANT_EDGE_CHARS);
	const source = [
		...selectedTools.map((span) => span.text),
		assistantTail ? `assistant action ${assistantTail}` : "",
		assistantHead && assistantHead !== assistantTail ? `assistant action ${assistantHead}` : "",
	].filter(Boolean).join("\n");
	if (!source) throw new Error("advisor_retrieval_query_empty");
	return source;
}

export async function prepareAdvisorRetrievalQuery(input: {
	delta: AdvisorPrimaryDelta;
	tokenizerAssetDir: string;
}): Promise<{ text: string; tokenCount: number }> {
	if (!input.delta || typeof input.delta.text !== "string") throw new Error("advisor_retrieval_delta_invalid");
	if (typeof input.tokenizerAssetDir !== "string" || !input.tokenizerAssetDir) throw new Error("advisor_tokenizer_unavailable");
	const tokenizer = await loadConfiguredTokenizer(input.tokenizerAssetDir);
	const source = prioritizedBehaviorSource(input.delta);
	const specialTokenCount = tokenizer.encode("", { add_special_tokens: true }).ids.length;
	const contentBudget = LOCAL_EMBEDDING_MAX_TOKENS - specialTokenCount;
	if (contentBudget < 1) throw new Error("advisor_tokenizer_special_token_overflow");
	const contentIds = tokenizer.encode(source, { add_special_tokens: false }).ids.slice(0, contentBudget);
	let text = compact(tokenizer.decode(contentIds, { skip_special_tokens: true }));
	if (!text) throw new Error("advisor_retrieval_query_empty");
	let tokenCount = tokenizer.encode(text, { add_special_tokens: true }).ids.length;
	while (tokenCount > LOCAL_EMBEDDING_MAX_TOKENS && contentIds.length > 1) {
		contentIds.pop();
		text = compact(tokenizer.decode(contentIds, { skip_special_tokens: true }));
		tokenCount = tokenizer.encode(text, { add_special_tokens: true }).ids.length;
	}
	if (!text || tokenCount > LOCAL_EMBEDDING_MAX_TOKENS) throw new Error("advisor_retrieval_query_overflow");
	return { text, tokenCount };
}
