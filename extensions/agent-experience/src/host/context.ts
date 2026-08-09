import type { DatabaseSync } from "node:sqlite";
import type { AgentExperienceConfig } from "../config.ts";
import { buildExperienceContextPack, retrieveExperienceCandidates, revalidateExperienceCandidate, type CurrentExperienceScope, type ExperienceContextPack, type ExperienceRetrievalCandidate } from "../experience/retrieval.ts";
import type { ExperienceKind } from "../experience/types.ts";
import type { EmbeddingAdapter } from "../semantic/types.ts";

export interface HostExperienceContextInput {
	userId: string;
	now: string;
	query: string;
	activeRequestExperienceIds?: string[];
	config: AgentExperienceConfig;
	embeddingAdapter: EmbeddingAdapter;
	kinds?: ExperienceKind[];
	currentScope?: CurrentExperienceScope;
	signal?: AbortSignal;
}

export interface ApprovedHostExperienceContext {
	candidates: ExperienceRetrievalCandidate[];
	advisor: ExperienceContextPack;
	assistantContext: ExperienceContextPack;
}

export async function retrieveApprovedHostExperienceContext(db: DatabaseSync, input: HostExperienceContextInput): Promise<ApprovedHostExperienceContext> {
	const candidates = await retrieveExperienceCandidates(db, input);
	for (const candidate of candidates) {
		revalidateExperienceCandidate(db, {
			userId: input.userId,
			now: input.now,
			alias: candidate.alias,
			candidates,
			config: input.config,
		});
	}
	return {
		candidates,
		advisor: buildExperienceContextPack(candidates, "advisor"),
		assistantContext: buildExperienceContextPack(candidates, "assistant_context"),
	};
}
