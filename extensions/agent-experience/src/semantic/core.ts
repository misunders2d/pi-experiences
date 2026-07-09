import { sha256Hex } from "../storage/checksum.ts";
import type { SemanticDedupePolicy } from "./types.ts";

export const SEMANTIC_EMBEDDING_INPUT_VERSION = "habit_embedding_input_v1";

export function normalizeSemanticText(value: unknown): string {
	return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function habitEmbeddingInputV1(input: { condition: string | null; behavior: string | null }): string {
	return `${normalizeSemanticText(input.condition)}\n${normalizeSemanticText(input.behavior)}`;
}

export function embeddingInputChecksum(text: string): string {
	return sha256Hex(`${SEMANTIC_EMBEDDING_INPUT_VERSION}\n${text}`);
}

export function normalizedVector(vector: Float32Array | number[]): Float32Array {
	const raw = vector instanceof Float32Array ? vector : Float32Array.from(vector);
	let sum = 0;
	for (const value of raw) {
		if (!Number.isFinite(value)) throw new Error("Invalid embedding vector value");
		sum += value * value;
	}
	const magnitude = Math.sqrt(sum);
	if (!Number.isFinite(magnitude) || magnitude <= 0) throw new Error("Invalid zero embedding vector");
	const out = new Float32Array(raw.length);
	for (let i = 0; i < raw.length; i++) out[i] = raw[i] / magnitude;
	return out;
}

export function vectorToBlob(vector: Float32Array): Buffer {
	return Buffer.from(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

export function blobToVector(blob: Buffer | Uint8Array, dimensions: number): Float32Array {
	const buffer = Buffer.from(blob);
	if (buffer.byteLength !== dimensions * 4) throw new Error("Embedding vector dimension mismatch");
	return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

export function vectorChecksum(vector: Float32Array): string {
	return sha256Hex(vectorToBlob(vector));
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length) throw new Error("Embedding vector dimension mismatch");
	if (!a.length) throw new Error("Embedding vector dimension mismatch");
	let dot = 0;
	let a2 = 0;
	let b2 = 0;
	for (let i = 0; i < a.length; i++) {
		const av = a[i];
		const bv = b[i];
		if (!Number.isFinite(av) || !Number.isFinite(bv)) throw new Error("Invalid embedding vector value");
		dot += av * bv;
		a2 += av * av;
		b2 += bv * bv;
	}
	if (a2 <= 0 || b2 <= 0) throw new Error("Invalid zero embedding vector");
	return dot / (Math.sqrt(a2) * Math.sqrt(b2));
}

export function cosineBp(a: Float32Array, b: Float32Array): number {
	const cosine = cosineSimilarity(a, b);
	if (!Number.isFinite(cosine)) throw new Error("Invalid embedding cosine");
	return Math.trunc(cosine * 10000);
}

export function classifySimilarityBp(similarityBp: number, policy: Pick<SemanticDedupePolicy, "reviewThresholdBp" | "strongThresholdBp">): "none" | "review" | "strong" {
	if (similarityBp >= policy.strongThresholdBp) return "strong";
	if (similarityBp >= policy.reviewThresholdBp) return "review";
	return "none";
}

export function semanticPairKey(a: string, b: string): { pairKey: string; habitA: string; habitB: string } {
	if (a === b) throw new Error("Semantic duplicate pair requires two habits");
	const [habitA, habitB] = [String(a), String(b)].sort();
	return { pairKey: `${habitA}\u0000${habitB}`, habitA, habitB };
}

export function chooseCanonicalHabit<T extends { id: string; created_at?: string }>(left: T, right: T): T {
	const leftCreated = String(left.created_at || "");
	const rightCreated = String(right.created_at || "");
	if (leftCreated && rightCreated && leftCreated !== rightCreated) return leftCreated < rightCreated ? left : right;
	return left.id <= right.id ? left : right;
}

export function defaultSemanticPolicy(overrides: Partial<SemanticDedupePolicy> = {}): SemanticDedupePolicy {
	return {
		enabled: false,
		provider: "openai-compatible",
		model: "text-embedding-3-small",
		dimensions: 1536,
		reviewThresholdBp: 7500,
		strongThresholdBp: 8500,
		timeoutMs: 10000,
		openAiCompatibleOptIn: false,
		...overrides,
	};
}
