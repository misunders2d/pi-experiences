import type { AgentExperienceConfig } from "../config.ts";
import { createLocalEmbeddingAdapter } from "./local-adapter.ts";
import {
	LOCAL_EMBEDDING_DIMENSIONS,
	LOCAL_EMBEDDING_MODEL,
	LOCAL_EMBEDDING_PROVIDER,
	LOCAL_EMBEDDING_REVIEW_THRESHOLD_BP,
	LOCAL_EMBEDDING_STRONG_THRESHOLD_BP,
	LOCAL_EMBEDDING_TIMEOUT_MS,
} from "./local-model-manifest.ts";
import { sanitizePolicy } from "./service.ts";
import type { EmbeddingAdapter, SemanticDedupePolicy } from "./types.ts";

export function semanticPolicyFromConfig(config: AgentExperienceConfig, overrides: Partial<SemanticDedupePolicy> = {}): SemanticDedupePolicy {
	return sanitizePolicy({
		enabled: config.embedding_enabled,
		provider: LOCAL_EMBEDDING_PROVIDER,
		model: LOCAL_EMBEDDING_MODEL,
		dimensions: LOCAL_EMBEDDING_DIMENSIONS,
		reviewThresholdBp: LOCAL_EMBEDDING_REVIEW_THRESHOLD_BP,
		strongThresholdBp: LOCAL_EMBEDDING_STRONG_THRESHOLD_BP,
		timeoutMs: LOCAL_EMBEDDING_TIMEOUT_MS,
		...overrides,
	});
}

export function createEmbeddingAdapterFromConfig(config: AgentExperienceConfig, root: string): EmbeddingAdapter | undefined {
	if (!config.embedding_enabled) return undefined;
	return createLocalEmbeddingAdapter(root);
}
