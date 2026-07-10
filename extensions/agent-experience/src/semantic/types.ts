export interface SemanticDedupePolicy {
	enabled: boolean;
	provider: string;
	model: string;
	dimensions: number;
	reviewThresholdBp: number;
	strongThresholdBp: number;
	timeoutMs: number;
}

export interface EmbeddingAdapter {
	readonly id: string;
	readonly provider: string;
	readonly model: string;
	readonly dimensions: number;
	embed(texts: string[], input?: { signal?: AbortSignal }): Promise<Float32Array[]>;
}

export interface SemanticHabitRow {
	id: string;
	user_id: string;
	status: string;
	condition: string | null;
	behavior: string | null;
	polarity: number;
	checksum: string;
	created_at: string;
	updated_at: string;
	data_json?: string;
}

export interface CachedHabitEmbedding {
	user_id: string;
	habit_id: string;
	embedding_input_version: string;
	embedding_input_checksum: string;
	habit_row_checksum: string;
	provider: string;
	model: string;
	dimensions: number;
	vector_blob: Buffer;
	vector_checksum: string;
	created_at: string;
	updated_at: string;
	row_checksum: string;
	vector: Float32Array;
}

export interface SemanticDuplicateMatch {
	habit: SemanticHabitRow;
	similarityBp: number;
	conditionSimilarityBp: number;
	behaviorSimilarityBp: number;
	strength: "review" | "strong";
}

export interface SemanticGateDecision {
	pass: boolean;
	reason: "disabled" | "pass" | "semantic_duplicate" | "semantic_unavailable";
	matches: SemanticDuplicateMatch[];
	policy: Pick<SemanticDedupePolicy, "enabled" | "provider" | "model" | "dimensions" | "reviewThresholdBp" | "strongThresholdBp">;
}
