import type { EmbeddingAdapter } from "./types.ts";

export interface OpenAICompatibleEmbeddingOptions {
	apiKey?: string;
	baseUrl?: string;
	model: string;
	dimensions: number;
	timeoutMs?: number;
}

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>, outerSignal?: AbortSignal): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const onAbort = () => controller.abort(outerSignal?.reason || new Error("embedding_aborted"));
	if (outerSignal) outerSignal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([
			fn(controller.signal),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort(new Error("embedding_timeout"));
					reject(new Error("embedding_timeout"));
				}, Math.max(1, ms));
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
		if (outerSignal) outerSignal.removeEventListener("abort", onAbort);
	}
}

export function createOpenAICompatibleEmbeddingAdapter(options: OpenAICompatibleEmbeddingOptions): EmbeddingAdapter {
	const apiKey = options.apiKey || process.env.OPENAI_API_KEY || process.env.AX_OPENAI_EMBEDDING_API_KEY;
	if (!apiKey) throw new Error("OpenAI-compatible embedding API key unavailable");
	const base = (options.baseUrl || process.env.AX_OPENAI_EMBEDDING_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
	return {
		id: `openai-compatible:${options.model}:${options.dimensions}`,
		provider: "openai-compatible",
		model: options.model,
		dimensions: options.dimensions,
		async embed(texts, input = {}) {
			return withTimeout(options.timeoutMs || 10000, async (signal) => {
				const response = await fetch(`${base}/embeddings`, {
					method: "POST",
					headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
					body: JSON.stringify({ model: options.model, input: texts, dimensions: options.dimensions }),
					signal,
				});
				if (!response.ok) throw new Error(`embedding_provider_http_${response.status}`);
				const json = await response.json() as any;
				const data = Array.isArray(json?.data) ? json.data.slice().sort((a: any, b: any) => Number(a.index) - Number(b.index)) : [];
				if (data.length !== texts.length) throw new Error("embedding_provider_bad_count");
				return data.map((item: any) => {
					if (!Array.isArray(item?.embedding) || item.embedding.length !== options.dimensions) throw new Error("embedding_provider_bad_dimensions");
					return Float32Array.from(item.embedding.map((value: any) => Number(value)));
				});
			}, input.signal);
		},
	};
}
