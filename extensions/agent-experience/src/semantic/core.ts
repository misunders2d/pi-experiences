import { sha256Hex } from "../storage/checksum.ts";
import { LOCAL_EMBEDDING_DIMENSIONS, LOCAL_EMBEDDING_MODEL, LOCAL_EMBEDDING_PROVIDER, LOCAL_EMBEDDING_REVIEW_THRESHOLD_BP, LOCAL_EMBEDDING_STRONG_THRESHOLD_BP, LOCAL_EMBEDDING_TIMEOUT_MS } from "./local-model-manifest.ts";
import type { SemanticDedupePolicy } from "./types.ts";

// Legacy whole-habit cache input. Retained so unchanged historical
// kept-separate decisions remain provable across scoring-method upgrades.
export const SEMANTIC_EMBEDDING_INPUT_VERSION = "habit_embedding_input_v1";
export const SEMANTIC_CONDITION_EMBEDDING_INPUT_VERSION = "habit_condition_embedding_input_v1";
export const SEMANTIC_BEHAVIOR_EMBEDDING_INPUT_VERSION = "habit_behavior_embedding_input_v1";
export const SEMANTIC_DUPLICATE_METHOD_VERSION = "habit_dedupe_field_min_v1";
export const SEMANTIC_WORDING_IDENTITY_VERSION = "habit_wording_identity_v1";

export function normalizeSemanticText(value: unknown): string {
	return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function habitEmbeddingInputV1(input: { condition: string | null; behavior: string | null }): string {
	return `${normalizeSemanticText(input.condition)}\n${normalizeSemanticText(input.behavior)}`;
}

export function habitConditionEmbeddingInputV1(input: { condition: string | null }): string {
	return `condition: ${normalizeSemanticText(input.condition)}`;
}

export function habitBehaviorEmbeddingInputV1(input: { behavior: string | null }): string {
	return `behavior: ${normalizeSemanticText(input.behavior)}`;
}

export function habitFieldEmbeddingInputsV1(input: { condition: string | null; behavior: string | null }): { condition: string; behavior: string } {
	return {
		condition: habitConditionEmbeddingInputV1(input),
		behavior: habitBehaviorEmbeddingInputV1(input),
	};
}

export function embeddingInputChecksum(text: string, version = SEMANTIC_EMBEDDING_INPUT_VERSION): string {
	return sha256Hex(`${version}\n${text}`);
}

export function semanticWordingIdentityChecksum(input: { condition: string | null; behavior: string | null; polarity: number }): string {
	return sha256Hex(`${SEMANTIC_WORDING_IDENTITY_VERSION}\n${normalizeSemanticText(input.condition)}\n${normalizeSemanticText(input.behavior)}\n${Number(input.polarity) === -1 ? -1 : 1}`);
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

export function effectiveFieldSimilarityBp(conditionSimilarityBp: number, behaviorSimilarityBp: number): number {
	if (!Number.isFinite(conditionSimilarityBp) || !Number.isFinite(behaviorSimilarityBp)) throw new Error("Invalid field similarity");
	return Math.max(-10000, Math.min(10000, Math.trunc(Math.min(conditionSimilarityBp, behaviorSimilarityBp))));
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
		provider: LOCAL_EMBEDDING_PROVIDER,
		model: LOCAL_EMBEDDING_MODEL,
		dimensions: LOCAL_EMBEDDING_DIMENSIONS,
		reviewThresholdBp: LOCAL_EMBEDDING_REVIEW_THRESHOLD_BP,
		strongThresholdBp: LOCAL_EMBEDDING_STRONG_THRESHOLD_BP,
		timeoutMs: LOCAL_EMBEDDING_TIMEOUT_MS,
		...overrides,
	};
}
