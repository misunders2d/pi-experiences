import type { AgentExperienceConfig } from "./config.ts";
import { filterEligibleSelectorCandidates, selectActiveSelectorSnapshot } from "./selector.ts";
import { prepareSelectorConditionVectors } from "./selector-vector.ts";
import { createLocalEmbeddingAdapter, type LocalEmbeddingAdapter } from "./semantic/local-adapter.ts";
import { getLocalEmbeddingAssetStatus } from "./semantic/local-model.ts";
import type { EmbeddingAdapter } from "./semantic/types.ts";

/**
 * Best-effort post-activation maintenance. Habit state is already committed and
 * is never rolled back because selector preparation fails. Runtime selection
 * remains fail-closed until setup repairs any missing vectors.
 */
export async function prepareActiveSelectorVectorsAfterChange(db: any, input: {
	root: string;
	userId: string;
	config: AgentExperienceConfig;
	now: string;
	signal?: AbortSignal;
	embeddingAdapter?: EmbeddingAdapter;
}): Promise<{ attempted: boolean; ready: boolean; total: number; prepared: number }> {
	if (!input.config.enabled || !input.config.selector_enabled) return { attempted: false, ready: true, total: 0, prepared: 0 };
	let adapter = input.embeddingAdapter;
	let owned: LocalEmbeddingAdapter | undefined;
	try {
		if (!adapter) {
			const status = await getLocalEmbeddingAssetStatus(input.root, { deep: true });
			if (!status.ready) return { attempted: true, ready: false, total: 0, prepared: 0 };
			owned = createLocalEmbeddingAdapter(input.root, { idleMs: 300_000 });
			adapter = owned;
		}
		const active = selectActiveSelectorSnapshot(db, { userId: input.userId });
		const eligible = filterEligibleSelectorCandidates(active, { minConfidenceBp: input.config.selector_min_confidence_bp, stalenessMax: input.config.selector_staleness_max });
		const result = await prepareSelectorConditionVectors(db, { userId: input.userId, candidates: eligible, embeddingAdapter: adapter, now: input.now, signal: input.signal });
		return { attempted: true, ready: true, total: result.total, prepared: result.prepared };
	} catch {
		return { attempted: true, ready: false, total: 0, prepared: 0 };
	} finally {
		await owned?.close().catch(() => undefined);
	}
}
