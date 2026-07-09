import type { AgentExperienceConfig } from "../config.ts";
import { createOpenAICompatibleEmbeddingAdapter } from "./openai-compatible.ts";
import { sanitizePolicy } from "./service.ts";
import type { EmbeddingAdapter, SemanticDedupePolicy } from "./types.ts";

export function semanticPolicyFromConfig(config: AgentExperienceConfig, overrides: Partial<SemanticDedupePolicy> = {}): SemanticDedupePolicy {
	return sanitizePolicy({
		enabled: config.embedding_enabled,
		provider: config.embedding_provider,
		model: config.embedding_model,
		dimensions: config.embedding_dimensions,
		reviewThresholdBp: config.embedding_review_threshold_bp,
		strongThresholdBp: config.embedding_strong_threshold_bp,
		timeoutMs: config.embedding_timeout_ms,
		openAiCompatibleOptIn: config.embedding_openai_compatible_opt_in,
		...overrides,
	});
}

export function createEmbeddingAdapterFromConfig(config: AgentExperienceConfig): EmbeddingAdapter | undefined {
	const policy = semanticPolicyFromConfig(config);
	if (policy.provider === "openai-compatible") {
		if (!policy.openAiCompatibleOptIn) return undefined;
		return createOpenAICompatibleEmbeddingAdapter({ model: policy.model, dimensions: policy.dimensions, timeoutMs: policy.timeoutMs });
	}
	return undefined;
}
