import type { DatabaseSync } from "node:sqlite";
import type { ExperienceContextPack } from "../experience/retrieval.ts";
import { retrieveApprovedHostExperienceContext, type HostExperienceContextInput } from "./context.ts";

export interface PiExperienceContext {
	selectorGuidance: Array<{ condition: string; behavior: string }>;
	assistantContext: ExperienceContextPack;
}

export async function buildPiExperienceContext(db: DatabaseSync, input: HostExperienceContextInput): Promise<PiExperienceContext> {
	const retrieved = await retrieveApprovedHostExperienceContext(db, input);
	return {
		selectorGuidance: retrieved.candidates
			.filter(candidate => candidate.experience.kind === "habit")
			.map(candidate => ({ condition: candidate.experience.applicability, behavior: candidate.experience.content })),
		assistantContext: retrieved.assistantContext,
	};
}
