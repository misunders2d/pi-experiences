import { sha256Hex } from "./storage/checksum.ts";
import { normalizeUserId } from "./storage/private-root.ts";
import {
	cosineBp,
	embeddingInputChecksum,
	habitConditionEmbeddingInputV1,
	normalizedVector,
	normalizeSemanticText,
} from "./semantic/core.ts";
import {
	getCachedHabitEmbeddingsBatch,
	upsertCachedHabitEmbedding,
	type HabitEmbeddingExpectation,
} from "./semantic/storage.ts";
import {
	LOCAL_EMBEDDING_DIMENSIONS,
	LOCAL_EMBEDDING_MAX_BATCH,
	LOCAL_EMBEDDING_MODEL,
	LOCAL_EMBEDDING_PROVIDER,
} from "./semantic/local-model-manifest.ts";
import type { EmbeddingAdapter } from "./semantic/types.ts";
import type { SelectorCandidate } from "./selector.ts";

export const SELECTOR_CONDITION_EMBEDDING_INPUT_VERSION = "selector_condition_embedding_input_v1";
export const SELECTOR_PROMPT_EMBEDDING_INPUT_VERSION = "selector_prompt_embedding_input_v1";
export const SELECTOR_VECTOR_RETRIEVAL_METHOD_VERSION = "selector_vector_retrieval_v1";
export const SELECTOR_VECTOR_RETRIEVAL_FLOOR_BP = 1500;
export const SELECTOR_VECTOR_RETRIEVAL_TOP_K = 12;
export const MAX_SELECTOR_ELIGIBLE_HABITS = 100;

export interface SelectorConditionVector {
	habitId: string;
	conditionIdentity: string;
	embeddingInputChecksum: string;
	vector: Float32Array;
}

export interface RetrievedSelectorCandidate {
	candidate: SelectorCandidate;
	conditionIdentity: string;
	similarityBp: number;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("selector_cancelled");
}

function assertLocalSelectorAdapter(adapter: EmbeddingAdapter): void {
	if (adapter.provider !== LOCAL_EMBEDDING_PROVIDER || adapter.model !== LOCAL_EMBEDDING_MODEL || adapter.dimensions !== LOCAL_EMBEDDING_DIMENSIONS) {
		throw new Error("selector_embedding_runtime_mismatch");
	}
}

export function selectorConditionEmbeddingInputV1(condition: string | null | undefined): string {
	return habitConditionEmbeddingInputV1({ condition: condition ?? "" });
}

export function selectorConditionIdentityChecksum(condition: string | null | undefined): string {
	return sha256Hex(`${SELECTOR_CONDITION_EMBEDDING_INPUT_VERSION}\n${normalizeSemanticText(condition)}`);
}

export function selectorPromptEmbeddingInputV1(prompt: string): string {
	const normalized = normalizeSemanticText(prompt);
	if (!normalized) throw new Error("selector_prompt_empty");
	return normalized.slice(0, 5000);
}

function expectationFor(candidate: SelectorCandidate): HabitEmbeddingExpectation {
	const text = selectorConditionEmbeddingInputV1(candidate.condition);
	return {
		habitId: candidate.id,
		embeddingInputChecksum: embeddingInputChecksum(text, SELECTOR_CONDITION_EMBEDDING_INPUT_VERSION),
		// Version-scoped compatibility note: for selector condition rows only, the
		// legacy-named habit_row_checksum column stores stable condition identity.
		// Mutable confidence/staleness changes therefore do not invalidate meaning.
		habitRowChecksum: selectorConditionIdentityChecksum(candidate.condition),
	};
}

function assertCandidateBounds(candidates: SelectorCandidate[]): void {
	if (candidates.length > MAX_SELECTOR_ELIGIBLE_HABITS) throw new Error("selector_candidate_limit_exceeded");
	const ids = new Set<string>();
	for (const candidate of candidates) {
		if (!candidate.id || ids.has(candidate.id)) throw new Error("selector_candidate_identity_invalid");
		ids.add(candidate.id);
	}
}

export function readSelectorConditionVectors(db: any, input: {
	userId: string;
	candidates: SelectorCandidate[];
	embeddingAdapter: EmbeddingAdapter;
}): Map<string, SelectorConditionVector> {
	assertLocalSelectorAdapter(input.embeddingAdapter);
	assertCandidateBounds(input.candidates);
	const expectations = input.candidates.map(expectationFor);
	const cached = getCachedHabitEmbeddingsBatch(db, {
		userId: normalizeUserId(input.userId),
		embeddingInputVersion: SELECTOR_CONDITION_EMBEDDING_INPUT_VERSION,
		provider: input.embeddingAdapter.provider,
		model: input.embeddingAdapter.model,
		dimensions: input.embeddingAdapter.dimensions,
		expectations,
		maxHabits: MAX_SELECTOR_ELIGIBLE_HABITS,
	});
	if (cached.missingIds.length || cached.invalidIds.length || cached.embeddings.size !== input.candidates.length) {
		throw new Error("selector_vectors_unavailable");
	}
	const byExpectation = new Map(expectations.map((expectation) => [expectation.habitId, expectation]));
	return new Map([...cached.embeddings].map(([habitId, row]) => {
		const expectation = byExpectation.get(habitId)!;
		return [habitId, {
			habitId,
			conditionIdentity: expectation.habitRowChecksum,
			embeddingInputChecksum: expectation.embeddingInputChecksum,
			vector: normalizedVector(row.vector),
		}];
	}));
}

export async function prepareSelectorConditionVectors(db: any, input: {
	userId: string;
	candidates: SelectorCandidate[];
	embeddingAdapter: EmbeddingAdapter;
	now: string;
	signal?: AbortSignal;
	batchSize?: number;
	onProgress?: (progress: { completed: number; total: number }) => void;
}): Promise<{ prepared: number; cached: number; total: number }> {
	assertLocalSelectorAdapter(input.embeddingAdapter);
	assertCandidateBounds(input.candidates);
	throwIfAborted(input.signal);
	const userId = normalizeUserId(input.userId);
	const expectations = input.candidates.map(expectationFor);
	const byId = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
	const inspected = getCachedHabitEmbeddingsBatch(db, {
		userId,
		embeddingInputVersion: SELECTOR_CONDITION_EMBEDDING_INPUT_VERSION,
		provider: input.embeddingAdapter.provider,
		model: input.embeddingAdapter.model,
		dimensions: input.embeddingAdapter.dimensions,
		expectations,
		maxHabits: MAX_SELECTOR_ELIGIBLE_HABITS,
	});
	const repairIds = [...new Set([...inspected.missingIds, ...inspected.invalidIds])].sort();
	const prepared = new Map<string, Float32Array>();
	const batchSize = Math.max(1, Math.min(LOCAL_EMBEDDING_MAX_BATCH, Math.trunc(input.batchSize ?? LOCAL_EMBEDDING_MAX_BATCH)));
	let completed = input.candidates.length - repairIds.length;
	input.onProgress?.({ completed, total: input.candidates.length });
	for (let offset = 0; offset < repairIds.length; offset += batchSize) {
		throwIfAborted(input.signal);
		const ids = repairIds.slice(offset, offset + batchSize);
		const texts = ids.map((id) => selectorConditionEmbeddingInputV1(byId.get(id)!.condition));
		const vectors = await input.embeddingAdapter.embed(texts, { signal: input.signal });
		if (!Array.isArray(vectors) || vectors.length !== ids.length) throw new Error("selector_embedding_vector_count_invalid");
		for (let index = 0; index < ids.length; index += 1) {
			const vector = vectors[index];
			if (!vector || vector.length !== input.embeddingAdapter.dimensions) throw new Error("selector_embedding_dimensions_invalid");
			prepared.set(ids[index], normalizedVector(vector));
		}
		completed += ids.length;
		input.onProgress?.({ completed, total: input.candidates.length });
	}
	throwIfAborted(input.signal);
	if (repairIds.length) {
		const placeholders = repairIds.map(() => "?").join(",");
		const freshRows = db.prepare(`SELECT id, user_id, condition FROM habits WHERE user_id = ? AND id IN (${placeholders}) ORDER BY id`).all(userId, ...repairIds);
		if (freshRows.length !== repairIds.length) throw new Error("selector_vector_snapshot_changed");
		for (const row of freshRows) {
			const candidate = byId.get(row.id);
			if (!candidate || row.user_id !== userId || selectorConditionIdentityChecksum(row.condition) !== selectorConditionIdentityChecksum(candidate.condition)) throw new Error("selector_vector_snapshot_changed");
		}
		db.exec("BEGIN IMMEDIATE");
		try {
			for (const habitId of repairIds) {
				const candidate = byId.get(habitId)!;
				const expectation = expectationFor(candidate);
				upsertCachedHabitEmbedding(db, {
					userId,
					habitId,
					embeddingInputVersion: SELECTOR_CONDITION_EMBEDDING_INPUT_VERSION,
					embeddingInputChecksum: expectation.embeddingInputChecksum,
					habitRowChecksum: expectation.habitRowChecksum,
					provider: input.embeddingAdapter.provider,
					model: input.embeddingAdapter.model,
					dimensions: input.embeddingAdapter.dimensions,
					vector: prepared.get(habitId)!,
					now: input.now,
				});
			}
			db.exec("COMMIT");
		} catch (error) {
			try { db.exec("ROLLBACK"); } catch {}
			throw error;
		}
	}
	// Final strict read proves setup produced a complete, valid selector cache.
	readSelectorConditionVectors(db, { userId, candidates: input.candidates, embeddingAdapter: input.embeddingAdapter });
	return { prepared: repairIds.length, cached: input.candidates.length - repairIds.length, total: input.candidates.length };
}

export interface SelectorPromptVectors {
	currentVector: Float32Array;
	contextVector?: Float32Array;
}

export async function embedSelectorPromptQueries(input: {
	prompt: string;
	contextualPrompt?: string;
	embeddingAdapter: EmbeddingAdapter;
	signal?: AbortSignal;
}): Promise<SelectorPromptVectors> {
	assertLocalSelectorAdapter(input.embeddingAdapter);
	throwIfAborted(input.signal);
	const texts = [selectorPromptEmbeddingInputV1(input.prompt)];
	if (input.contextualPrompt?.trim()) texts.push(selectorPromptEmbeddingInputV1(input.contextualPrompt));
	const vectors = await input.embeddingAdapter.embed(texts, { signal: input.signal });
	throwIfAborted(input.signal);
	if (!Array.isArray(vectors) || vectors.length !== texts.length || vectors.some((vector) => vector?.length !== input.embeddingAdapter.dimensions)) {
		throw new Error("selector_prompt_embedding_invalid");
	}
	return {
		currentVector: normalizedVector(vectors[0]),
		contextVector: vectors[1] ? normalizedVector(vectors[1]) : undefined,
	};
}

export async function embedSelectorPrompt(input: {
	prompt: string;
	embeddingAdapter: EmbeddingAdapter;
	signal?: AbortSignal;
}): Promise<Float32Array> {
	return (await embedSelectorPromptQueries(input)).currentVector;
}

export function retrieveSelectorCandidates(input: {
	candidates: SelectorCandidate[];
	conditionVectors: Map<string, SelectorConditionVector>;
	promptVector: Float32Array;
	floorBp?: number;
	topK?: number;
}): RetrievedSelectorCandidate[] {
	assertCandidateBounds(input.candidates);
	if (input.promptVector.length !== LOCAL_EMBEDDING_DIMENSIONS) throw new Error("selector_prompt_embedding_invalid");
	const floorBp = Math.max(-10000, Math.min(10000, Math.trunc(input.floorBp ?? SELECTOR_VECTOR_RETRIEVAL_FLOOR_BP)));
	const topK = Math.max(1, Math.min(SELECTOR_VECTOR_RETRIEVAL_TOP_K, Math.trunc(input.topK ?? SELECTOR_VECTOR_RETRIEVAL_TOP_K)));
	const ranked = input.candidates.map((candidate) => {
		const condition = input.conditionVectors.get(candidate.id);
		if (!condition) throw new Error("selector_vectors_unavailable");
		return {
			candidate,
			conditionIdentity: condition.conditionIdentity,
			similarityBp: cosineBp(input.promptVector, condition.vector),
		};
	});
	return ranked
		.filter((item) => item.similarityBp >= floorBp)
		.sort((left, right) => (right.similarityBp - left.similarityBp) || right.candidate.confidence_bp - left.candidate.confidence_bp || left.candidate.id.localeCompare(right.candidate.id))
		.slice(0, topK);
}

export function unionRetrievedSelectorCandidates(input: {
	primary: RetrievedSelectorCandidate[];
	secondary?: RetrievedSelectorCandidate[];
	topK?: number;
}): RetrievedSelectorCandidate[] {
	const topK = Math.max(1, Math.min(SELECTOR_VECTOR_RETRIEVAL_TOP_K, Math.trunc(input.topK ?? SELECTOR_VECTOR_RETRIEVAL_TOP_K)));
	const seen = new Set<string>();
	const union: RetrievedSelectorCandidate[] = [];
	for (const item of [...input.primary, ...(input.secondary ?? [])]) {
		if (seen.has(item.candidate.id)) continue;
		seen.add(item.candidate.id);
		union.push(item);
		if (union.length >= topK) break;
	}
	return union;
}
