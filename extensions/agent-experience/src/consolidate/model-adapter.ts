import { EXPERIENCE_AUTHORITIES, EXPERIENCE_KINDS, EXPERIENCE_SCOPE_KINDS } from "../experience/types.ts";
import type { AssistantMessage, completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compactContextIdentity, type CompactHabitContextItem } from "./context.ts";
import type { ValidatedObservationRecord } from "./observations.ts";
import { FRICTION_EXTRACTION_INSTRUCTIONS, GENERALIZED_HABIT_INSTRUCTIONS, HABIT_CLASSIFICATION_RUBRIC, HABIT_FEWSHOT_EXAMPLES } from "./prompt.ts";
import { redactText } from "../storage/redaction.ts";
import { situationUnitsForModel, validateSituationEvidenceForProposal, type SituationBatch, type SituationEvidenceBasis } from "./situations.ts";

export interface ConsolidationModelAdapterInput {
	model: string;
	userId: string;
	observations: ValidatedObservationRecord[];
	habitContext: CompactHabitContextItem[];
	expected: { file_generation: string; seq_start: number; seq_end: number; read_checksum: string };
	situationBatch?: SituationBatch;
	signal?: AbortSignal;
}

export interface ConsolidationModelAdapter {
	generate(input: ConsolidationModelAdapterInput): Promise<unknown>;
}

export function parseProviderModel(value: string): { provider: string; modelId: string } | undefined {
	const slash = value.indexOf("/");
	if (slash <= 0) return undefined;
	const provider = value.slice(0, slash);
	const modelId = value.slice(slash + 1);
	if (!provider || !modelId || provider.includes("..") || modelId.includes("..") || modelId.includes("\0")) return undefined;
	return { provider, modelId };
}

export function truncateForModel(value: unknown, max = 900): string {
	const text = redactText(typeof value === "string" ? value : JSON.stringify(value ?? {}));
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function advisorFingerprint(record: ValidatedObservationRecord): string | undefined {
	if (record.origin.source !== "advisor_finding") return undefined;
	const payload = record.payload_redacted as { kind?: unknown; event_fingerprint?: unknown } | undefined;
	return payload?.kind === "advisor_finding_v1" && typeof payload.event_fingerprint === "string"
		? payload.event_fingerprint
		: undefined;
}

function collapseAdvisorObservations(observations: ValidatedObservationRecord[]): ValidatedObservationRecord[] {
	const fingerprints = new Set<string>();
	return observations.filter((record) => {
		const fingerprint = advisorFingerprint(record);
		if (!fingerprint) return true;
		if (fingerprints.has(fingerprint)) return false;
		fingerprints.add(fingerprint);
		return true;
	});
}

function observationsForModelPrompt(observations: ValidatedObservationRecord[]): unknown[] {
	return collapseAdvisorObservations(observations).map((record) => {
		const payload = record.payload_redacted && typeof record.payload_redacted === "object" && !Array.isArray(record.payload_redacted)
			? record.payload_redacted as Record<string, unknown>
			: {};
		if (payload?.kind === "advisor_finding_v1") {
			return {
				seq: record.seq,
				checksum: record.checksum,
				created_at: record.created_at,
				origin: "advisor_finding",
				assistant: truncateForModel(payload.primary_behavior_redacted, 1200),
				advisor_finding: truncateForModel(payload.approved_behavior_redacted, 900),
				severity: payload.severity,
			};
		}
		return {
			seq: record.seq,
			checksum: record.checksum,
			created_at: record.created_at,
			origin: record.origin.source,
			user: truncateForModel(payload?.user_text_redacted, 900),
			assistant: truncateForModel(payload?.assistant_text_redacted, 1200),
		};
	});
}

function extractionJson(text: string): unknown {
	const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
	try { return JSON.parse(trimmed); } catch {}
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
	throw new Error("habit_learning_model_invalid_json");
}

function extractAssistantText(message: AssistantMessage | undefined): string {
	const parts = Array.isArray((message as any)?.content) ? (message as any).content : [];
	return parts
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.slice(0, 20000);
}

export function buildConsolidationSystemPrompt(fileGeneration: string): string {
	const outputSchema = {
		schema_version: 1,
		assessments: [{
			unit_ref: "opaque-unit-id-from-input",
			objective: "bounded factual objective",
			constraints: ["factual constraint"],
			consequential_action: "what the assistant actually did",
			actual_user_feedback: "user_reported_feedback | explicit_durable_preference | unrelated_followup | unknown",
			support_quotes: [{ role: "user", quote: "exact quote from linked_user_turn or exact_user_statement" }],
			mechanism: { classification: "observed | inferred | unknown", summary: "bounded mechanism" },
			unknowns: ["what evidence does not establish"],
			applicability: "where a reusable lesson would apply",
			exceptions: ["where it would not apply"],
			durability: "durable_reusable | task_local | unknown",
		}],
		user_id: "owner",
		file_generation: fileGeneration,
		batch_id: "manual-id",
		model: "provider/model",
		created_at: "ISO",
		observations_read: { seq_start: 1, seq_end: 3, checksum: "last-read-checksum" },
		proposals: [{
			proposal_id: "p1",
			kind: "habit_candidate",
			candidate_key: "stable-kebab-key",
			condition: "When ...",
			behavior: "Do ...",
			polarity: 1,
			confidence_bp: 8000,
			source_refs: [{ file_generation: fileGeneration, seq: 1, checksum: "server-validated-checksum" }],
			evidence_unit_refs: ["opaque-unit-id-from-input"],
			evidence_basis: "inferred_pattern",
			evidence_summary: "short redacted summary",
			ambiguous: false,
		}],
	};
	return [
		"You are Agent Experience habit learning.",
		"Return JSON only. No prose. No markdown unless JSON object only.",
		"Infer durable user preferences or corrections from redacted user/assistant observations.",
		...FRICTION_EXTRACTION_INSTRUCTIONS,
		"Assess only promising evidence units, before proposing anything. Emit at most 6 concise assessments and 0-3 proposals within one shared 12,000-character assessment budget; empty assessments with zero proposals is valid. A linked_turn proves chronology only, never success, failure, or relevance.",
		"Every cited proposal unit must have one complete assessment separating objective/constraints, consequential assistant action, actual user feedback, role-bound exact user quote support, observed vs inferred mechanism, unknowns, applicability/exceptions, and durable-vs-task-local verdict. Never cite an unassessed unit.",
		"Use actual_user_feedback=user_reported_feedback only when the linked user turn itself reports an outcome or correction. Use unrelated_followup for a new task and unknown when evidence does not establish feedback. Assistant success claims never prove outcomes.",
		"Only propose habits supported by supplied units having complete admissible assessments. Unknown feedback, unrelated follow-ups, and task-local assessments cannot support proposals. Inferred patterns also require a non-unknown mechanism; an exact explicit future/general preference may mark mechanism unknown or not applicable without inventing a cause.",
		"For inferred patterns, cite evidence_basis=inferred_pattern and only assessed linked_turn unit refs.",
		"For one explicit durable future/general preference, cite evidence_basis=explicit_durable_preference, exactly one assessed explicit_user_statement unit ref, and exact_user_quote copied verbatim from that user-role unit. Do not treat a task-local command as durable.",
		"Advisor findings are lower-authority context only: they cannot prove outcomes, explicit-user authority, or independent situations.",
		"Do not include secrets, emails, phone numbers, tokens, raw prompts, private paths, or private identifiers.",
		"Prefer 0-3 concise candidate habits. Return zero proposals if evidence is weak.",
		"Only propose repeated patterns, except one unmistakable explicit durable preference. Combine compact existing habit context with the new validated units.",
		"A repeated habit needs at least 3 server-validated independent conversation lineages across at least 2 days. Multiple turns or branches from one lineage count once.",
		"When the same pattern recurs, reuse its exact canonical condition, behavior, and polarity from existing_habit_context. Do not paraphrase or fork it.",
		...GENERALIZED_HABIT_INSTRUCTIONS,
		...HABIT_CLASSIFICATION_RUBRIC,
		...HABIT_FEWSHOT_EXAMPLES,
		"Every proposal must cite only supplied opaque evidence_unit_refs; source_refs is server-derived and model-provided values are ignored. If units are absent or none have admissible assessments, return zero proposals. Legacy observations and Advisor findings cannot bypass this contract. Never invent historical references.",
		"All proposals are inactive candidates. Never approve or activate them.",
		"Exact output schema:",
		JSON.stringify(outputSchema),
	].join("\n");
}

export function buildConsolidationUserPrompt(input: ConsolidationModelAdapterInput): string {
	return JSON.stringify({
		task: "Analyze these redacted examples and produce reviewable behavioral habit suggestions.",
		user_id: input.userId,
		file_generation: input.expected.file_generation,
		model: input.model,
		created_at: new Date().toISOString(),
		observations_read: { seq_start: input.expected.seq_start, seq_end: input.expected.seq_end, checksum: input.expected.read_checksum },
		existing_habit_context: (input.habitContext || []).map(({ advisor_event_fingerprints: _internalFingerprints, ...visible }) => visible),
		validated_evidence_units: input.situationBatch ? situationUnitsForModel(input.situationBatch) : [],
		// Raw observations are legacy-only. New capture contract exposes only bounded neutral units.
		observations: input.situationBatch ? [] : observationsForModelPrompt(input.observations),
	}, null, 2);
}

function requireNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`habit_learning_model_missing_${field}`);
	return redactText(value.trim()).slice(0, 1000);
}

function normalizeSourceRefs(rawRefs: unknown, input: ConsolidationModelAdapterInput): { file_generation: string; seq: number; checksum: string }[] {
	if (!Array.isArray(rawRefs) || rawRefs.length === 0) throw new Error("habit_learning_model_missing_source_refs");
	const bySeq = new Map(input.observations.map((record) => [record.seq, record]));
	const refs = rawRefs.map((ref: any) => {
		if (!Number.isInteger(ref?.seq)) throw new Error("habit_learning_model_missing_source_ref_seq");
		const record = bySeq.get(ref.seq);
		if (!record) throw new Error("habit_learning_model_invalid_source_ref");
		const suppliedGeneration = typeof ref?.file_generation === "string" ? ref.file_generation : input.expected.file_generation;
		if (suppliedGeneration !== record.file_generation) throw new Error("habit_learning_model_source_ref_generation_mismatch");
		return { file_generation: record.file_generation, seq: record.seq, checksum: record.checksum };
	});
	return refs.filter((ref, index, array) => array.findIndex((candidate) => candidate.seq === ref.seq) === index);
}

type SituationAssessment = {
	unit_ref: string;
	actual_user_feedback: "user_reported_feedback" | "explicit_durable_preference" | "unrelated_followup" | "unknown";
	durability: "durable_reusable" | "task_local" | "unknown";
	mechanism_classification: "observed" | "inferred" | "unknown";
};

const assessmentValidatedOutputs = new WeakSet<object>();

function requireStringArray(value: unknown, field: string, maxItems: number): string[] {
	if (!Array.isArray(value) || value.length > maxItems) throw new Error(`habit_learning_model_invalid_${field}`);
	return value.map((item) => requireNonEmptyString(item, field).slice(0, 400));
}

function validateSituationAssessments(raw: unknown, input: ConsolidationModelAdapterInput): Map<string, SituationAssessment> {
	const units = input.situationBatch?.units || [];
	if (raw === undefined && units.length === 0) return new Map();
	if (!Array.isArray(raw) || raw.length > 6 || JSON.stringify(raw).length > 12_000) throw new Error("habit_learning_model_invalid_situation_assessments");
	const byUnit = new Map(units.map((unit) => [unit.evidence_unit_ref, unit]));
	const assessments = new Map<string, SituationAssessment>();
	for (const value of raw) {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("habit_learning_model_invalid_situation_assessment");
		const item = value as any;
		const allowed = new Set(["unit_ref", "objective", "constraints", "consequential_action", "actual_user_feedback", "support_quotes", "mechanism", "unknowns", "applicability", "exceptions", "durability"]);
		if (Object.keys(item).some((key) => !allowed.has(key))) throw new Error("habit_learning_model_invalid_situation_assessment_field");
		const unitRef = requireNonEmptyString(item.unit_ref, "assessment_unit_ref");
		const unit = byUnit.get(unitRef);
		if (!unit || assessments.has(unitRef)) throw new Error("habit_learning_model_invalid_assessment_unit_ref");
		requireNonEmptyString(item.objective, "assessment_objective");
		requireStringArray(item.constraints, "assessment_constraints", 12);
		requireNonEmptyString(item.consequential_action, "assessment_consequential_action");
		if (!["user_reported_feedback", "explicit_durable_preference", "unrelated_followup", "unknown"].includes(item.actual_user_feedback)) throw new Error("habit_learning_model_invalid_actual_user_feedback");
		if (!Array.isArray(item.support_quotes) || item.support_quotes.length > 6) throw new Error("habit_learning_model_invalid_support_quotes");
		const quoteSource = unit.kind === "linked_turn" ? unit.linked_user_turn_redacted : unit.user_statement_redacted;
		for (const support of item.support_quotes) {
			if (!support || typeof support !== "object" || Array.isArray(support) || Object.keys(support).some((key) => key !== "role" && key !== "quote") || support.role !== "user") throw new Error("habit_learning_model_invalid_role_bound_quote");
			const quote = requireNonEmptyString(support.quote, "support_quote").slice(0, 400);
			if (!quoteSource?.includes(quote)) throw new Error("habit_learning_model_forged_support_quote");
		}
		if ((item.actual_user_feedback === "user_reported_feedback" || item.actual_user_feedback === "explicit_durable_preference") && item.support_quotes.length < 1) throw new Error("habit_learning_model_missing_support_quote");
		if (!item.mechanism || typeof item.mechanism !== "object" || Array.isArray(item.mechanism) || Object.keys(item.mechanism).some((key: string) => key !== "classification" && key !== "summary")) throw new Error("habit_learning_model_invalid_mechanism");
		if (!["observed", "inferred", "unknown"].includes(item.mechanism.classification)) throw new Error("habit_learning_model_invalid_mechanism_classification");
		requireNonEmptyString(item.mechanism.summary, "assessment_mechanism_summary");
		requireStringArray(item.unknowns, "assessment_unknowns", 12);
		requireNonEmptyString(item.applicability, "assessment_applicability");
		requireStringArray(item.exceptions, "assessment_exceptions", 12);
		if (!["durable_reusable", "task_local", "unknown"].includes(item.durability)) throw new Error("habit_learning_model_invalid_durability");
		assessments.set(unitRef, { unit_ref: unitRef, actual_user_feedback: item.actual_user_feedback, durability: item.durability, mechanism_classification: item.mechanism.classification });
	}
	return assessments;
}

function normalizeSituationEvidence(proposal: any, input: ConsolidationModelAdapterInput, assessments?: Map<string, SituationAssessment>): {
	source_refs: { file_generation: string; seq: number; checksum: string }[];
	evidence_unit_refs?: string[];
	evidence_basis?: SituationEvidenceBasis;
	exact_user_quote?: string;
} {
	if (!input.situationBatch) return { source_refs: normalizeSourceRefs(proposal?.source_refs, input) };
	if (!Array.isArray(proposal?.evidence_unit_refs)) throw new Error("habit_learning_model_missing_evidence_unit_refs");
	const evidence_unit_refs = proposal.evidence_unit_refs.map((value: unknown) => requireNonEmptyString(value, "evidence_unit_ref"));
	const evidence_basis = proposal.evidence_basis as SituationEvidenceBasis;
	const exact_user_quote = proposal.exact_user_quote === undefined ? undefined : String(proposal.exact_user_quote).trim();
	const byId = new Map(input.situationBatch.units.map((unit) => [unit.evidence_unit_ref, unit]));
	const source_refs = evidence_unit_refs.flatMap((id) => byId.get(id)?.current_source_refs || [])
		.filter((ref, index, refs) => refs.findIndex((candidate) => candidate.file_generation === ref.file_generation && candidate.seq === ref.seq && candidate.checksum === ref.checksum) === index);
	const units = validateSituationEvidenceForProposal({ source_refs, evidence_unit_refs, evidence_basis, ...(exact_user_quote === undefined ? {} : { exact_user_quote }) }, input.situationBatch);
	for (const unit of units) {
		const assessment = assessments?.get(unit.evidence_unit_ref);
		if (!assessment || assessment.durability !== "durable_reusable") throw new Error("habit_learning_model_inadmissible_situation_assessment");
		if (evidence_basis === "inferred_pattern") {
			if (assessment.mechanism_classification === "unknown") throw new Error("habit_learning_model_inadmissible_situation_assessment");
			if (assessment.actual_user_feedback !== "user_reported_feedback") throw new Error("habit_learning_model_inadmissible_feedback_assessment");
		}
		if (evidence_basis === "explicit_durable_preference" && assessment.actual_user_feedback !== "explicit_durable_preference") throw new Error("habit_learning_model_inadmissible_preference_assessment");
	}
	return { source_refs, evidence_unit_refs, evidence_basis, ...(exact_user_quote === undefined ? {} : { exact_user_quote }) };
}

function newEvidenceStats(refs: { seq: number }[], input: ConsolidationModelAdapterInput) {
	const bySeq = new Map(input.observations.map((record) => [record.seq, record]));
	const nonAdvisorSeqs = new Set<number>();
	const nonAdvisorDays = new Set<string>();
	const advisorEvents = new Map<string, string>();
	for (const ref of refs) {
		const record = bySeq.get(ref.seq);
		if (!record) continue;
		const fingerprint = advisorFingerprint(record);
		const day = new Date(record.created_at).toISOString().slice(0, 10);
		if (fingerprint) {
			if (!advisorEvents.has(fingerprint)) advisorEvents.set(fingerprint, day);
			continue;
		}
		nonAdvisorSeqs.add(record.seq);
		nonAdvisorDays.add(day);
	}
	return { nonAdvisorSeqs, nonAdvisorDays, advisorEvents };
}

function matchingHabitContext(input: ConsolidationModelAdapterInput, candidate: { condition: unknown; behavior: unknown; polarity: unknown }): CompactHabitContextItem | undefined {
	const identity = compactContextIdentity(candidate);
	return (input.habitContext || []).find((item) => compactContextIdentity(item) === identity);
}

function hasEnoughRepeatedEvidence(refs: { seq: number }[], input: ConsolidationModelAdapterInput, candidate: { condition: unknown; behavior: unknown; polarity: unknown }): boolean {
	const fresh = newEvidenceStats(refs, input);
	const existing = matchingHabitContext(input, candidate);
	const existingFingerprints = new Set(existing?.advisor_event_fingerprints || []);
	const newAdvisorEvents = [...fresh.advisorEvents].filter(([fingerprint]) => !existingFingerprints.has(fingerprint));
	const days = new Set([
		...(existing?.source_dates || []),
		...fresh.nonAdvisorDays,
		...newAdvisorEvents.map(([, day]) => day),
	]);
	const count = Number(existing?.unique_observations || 0) + fresh.nonAdvisorSeqs.size + newAdvisorEvents.length;
	return count >= 3 && days.size >= 2;
}

function withoutAdvisorEvidence(refs: { seq: number }[], input: ConsolidationModelAdapterInput): { seq: number }[] {
	const bySeq = new Map(input.observations.map((record) => [record.seq, record]));
	return refs.filter((ref) => bySeq.get(ref.seq)?.origin.source !== "advisor_finding");
}

function normalizeConfidence(value: unknown): number {
	if (!Number.isInteger(value) || value < 0 || value > 10000) throw new Error("habit_learning_model_invalid_confidence");
	return value;
}
const EXPERIENCE_KIND_SET = new Set(EXPERIENCE_KINDS);
const EXPERIENCE_SCOPE_SET = new Set(EXPERIENCE_SCOPE_KINDS);
const EXPERIENCE_AUTHORITY_SET = new Set(EXPERIENCE_AUTHORITIES);
const UNTRUSTED_INSTRUCTION_PATTERN = /<\/?system|ignore\s+(?:all\s+|previous\s+)?instructions|tool\s+output\s+(?:says|instructs)/i;


export function normalizeConsolidationModelOutput(raw: any, input: ConsolidationModelAdapterInput, options: { habitsOnly?: boolean } = {}): unknown {
	if (input.situationBatch && (!Array.isArray(raw?.proposals) || raw.proposals.length > 3)) throw new Error("habit_learning_model_invalid_proposal_count");
	const assessments = input.situationBatch ? validateSituationAssessments(raw?.assessments, input) : undefined;
	const proposals = Array.isArray(raw?.proposals) ? raw.proposals.slice(0, input.situationBatch ? 3 : 50).flatMap((proposal: any) => {
		if (options.habitsOnly && EXPERIENCE_KIND_SET.has(proposal?.kind)) return [];
		if (EXPERIENCE_KIND_SET.has(proposal?.kind)) {
			const situationEvidence = normalizeSituationEvidence(proposal, input, assessments);
			const source_refs = situationEvidence.source_refs;
			if (!proposal.scope || typeof proposal.scope !== "object" || Array.isArray(proposal.scope)) {
				throw new Error("experience_learning_model_invalid_scope");
			}
			if (!EXPERIENCE_SCOPE_SET.has(proposal.scope.kind)) throw new Error("experience_learning_model_invalid_scope");
			const scope = proposal.scope.kind === "user"
				? { kind: "user" }
				: { kind: proposal.scope.kind, key: requireNonEmptyString(proposal.scope.key, "scope_key") };
			if (!EXPERIENCE_AUTHORITY_SET.has(proposal.authority)) throw new Error("experience_learning_model_invalid_authority");
			const applicability = requireNonEmptyString(proposal.applicability, "applicability");
			const content = requireNonEmptyString(proposal.content, "content");
			if (UNTRUSTED_INSTRUCTION_PATTERN.test(applicability) || UNTRUSTED_INSTRUCTION_PATTERN.test(content)) {
				throw new Error("experience_learning_model_untrusted_instruction");
			}
			const rationale = typeof proposal.rationale === "string" && !proposal.rationale.trim()
				? undefined
				: proposal.rationale === undefined ? undefined : requireNonEmptyString(proposal.rationale, "rationale");
			if (!Array.isArray(proposal.exceptions) || proposal.exceptions.length > 32) {
				throw new Error("experience_learning_model_invalid_exceptions");
			}
			const exceptions = proposal.exceptions.map((exception: unknown) => requireNonEmptyString(exception, "exception"));
			const explicitAuthorityRefs = withoutAdvisorEvidence(source_refs, input);
			if (proposal.authority === "explicit_user" && explicitAuthorityRefs.length === 0) {
				throw new Error("experience_learning_model_explicit_authority_without_user_source");
			}
			const needsRepetition = proposal.kind === "habit"
				|| (proposal.kind === "preference" && proposal.authority !== "explicit_user");
			if (needsRepetition && !hasEnoughRepeatedEvidence(source_refs, input, {
				condition: applicability,
				behavior: content,
				polarity: 1,
			})) return [];
			return [{
				proposal_id: requireNonEmptyString(proposal.proposal_id, "proposal_id"),
				kind: proposal.kind,
				candidate_key: requireNonEmptyString(proposal.candidate_key, "candidate_key"),
				scope,
				authority: proposal.authority,
				applicability,
				content,
				...(rationale === undefined ? {} : { rationale }),
				exceptions,
				confidence_bp: normalizeConfidence(proposal.confidence_bp),
				source_refs,
				...(proposal.evidence_summary ? { evidence_summary: redactText(String(proposal.evidence_summary)).slice(0, 1000) } : {}),
				...(situationEvidence.evidence_unit_refs ? situationEvidence : {}),
				ambiguous: proposal.ambiguous === true,
			}];
		}
		const situationEvidence = normalizeSituationEvidence(proposal, input, assessments);
		const source_refs = situationEvidence.source_refs;
		if (proposal?.kind === "correction_split") {
			const old_condition = requireNonEmptyString(proposal.old_condition, "old_condition");
			const old_behavior = requireNonEmptyString(proposal.old_behavior, "old_behavior");
			const new_condition = requireNonEmptyString(proposal.new_condition, "new_condition");
			const new_behavior = requireNonEmptyString(proposal.new_behavior, "new_behavior");
			const confidence_bp = normalizeConfidence(proposal.confidence_bp);
			const correctionAuthorityRefs = withoutAdvisorEvidence(source_refs, input);
			const repeatedReplacement = hasEnoughRepeatedEvidence(correctionAuthorityRefs, input, { condition: new_condition, behavior: new_behavior, polarity: 1 });
			const oldContext = matchingHabitContext(input, { condition: old_condition, behavior: old_behavior, polarity: 1 });
			const explicitCorrection = confidence_bp >= 8500 && correctionAuthorityRefs.length >= 1 && oldContext?.status === "active";
			const evidence_stage = repeatedReplacement || explicitCorrection ? "reviewable" : "collecting";
			return [{
				proposal_id: requireNonEmptyString(proposal.proposal_id, "proposal_id"),
				kind: "correction_split",
				candidate_key: requireNonEmptyString(proposal.candidate_key, "candidate_key"),
				old_condition,
				old_behavior,
				new_condition,
				new_behavior,
				confidence_bp,
				source_refs,
				evidence_stage,
				...(proposal.evidence_summary ? { evidence_summary: redactText(String(proposal.evidence_summary)).slice(0, 1000) } : {}),
				...(situationEvidence.evidence_unit_refs ? situationEvidence : {}),
				ambiguous: proposal.ambiguous === true,
			}];
		}
		if (proposal?.kind !== "habit_candidate") throw new Error("habit_learning_model_invalid_proposal_kind");
		const condition = requireNonEmptyString(proposal.condition, "condition");
		const behavior = requireNonEmptyString(proposal.behavior, "behavior");
		const polarity = proposal.polarity === -1 ? -1 : 1;
		const evidence_stage = hasEnoughRepeatedEvidence(source_refs, input, { condition, behavior, polarity }) ? "reviewable" : "collecting";
		return [{
			proposal_id: requireNonEmptyString(proposal.proposal_id, "proposal_id"),
			kind: "habit_candidate",
			candidate_key: requireNonEmptyString(proposal.candidate_key, "candidate_key"),
			condition,
			behavior,
			polarity,
			confidence_bp: normalizeConfidence(proposal.confidence_bp),
			source_refs,
			evidence_stage,
			...(proposal.evidence_summary ? { evidence_summary: redactText(String(proposal.evidence_summary)).slice(0, 1000) } : {}),
			...(situationEvidence.evidence_unit_refs ? situationEvidence : {}),
			ambiguous: proposal.ambiguous === true,
		}];
	}) : [];
	const normalized = {
		schema_version: 1,
		user_id: input.userId,
		file_generation: input.expected.file_generation,
		batch_id: String(raw?.batch_id || `manual-${Date.now()}`),
		model: input.model,
		created_at: new Date().toISOString(),
		observations_read: { seq_start: input.expected.seq_start, seq_end: input.expected.seq_end, checksum: input.expected.read_checksum },
		proposals,
	};
	if (input.situationBatch) assessmentValidatedOutputs.add(normalized);
	return normalized;
}

export function isAssessmentValidatedModelOutput(value: unknown): boolean {
	return !!value && typeof value === "object" && assessmentValidatedOutputs.has(value as object);
}

export function __normalizeAgentExperienceConsolidationModelOutputForTest(raw: any, input: ConsolidationModelAdapterInput, options: { habitsOnly?: boolean } = {}): unknown {
	return normalizeConsolidationModelOutput(raw, input, options);
}

export function __buildAgentExperienceConsolidationSystemPromptForTest(fileGeneration = "active"): string {
	return buildConsolidationSystemPrompt(fileGeneration);
}

export function createPiConsolidationModelAdapter(
	ctx: Pick<ExtensionContext, "modelRegistry" | "signal">,
	options: { complete: typeof completeSimple; purpose?: string },
): ConsolidationModelAdapter {
	const purpose = options.purpose || "agent-experience-manual-habit-learning";
	return {
		async generate(input) {
			const parsed = parseProviderModel(input.model);
			if (!parsed) throw new Error("habit_learning_model_invalid");
			const model = ctx.modelRegistry?.find?.(parsed.provider, parsed.modelId);
			if (!model) throw new Error("habit_learning_model_unavailable");
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) throw new Error("habit_learning_model_auth_unavailable");
			const response = await options.complete(model, {
				systemPrompt: buildConsolidationSystemPrompt(input.expected.file_generation),
				messages: [{ role: "user", content: buildConsolidationUserPrompt(input), timestamp: Date.now() }],
			}, {
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal: input.signal ?? ctx.signal,
				timeoutMs: 120000,
				maxRetries: 1,
				maxRetryDelayMs: 0,
				maxTokens: 4096,
				reasoning: "high",
				metadata: { purpose },
			} as any);
			if ((response as any)?.stopReason === "length") throw new Error("habit_learning_model_truncated_response");
			const text = extractAssistantText(response);
			if (!text.trim()) throw new Error("habit_learning_model_empty_response");
			return normalizeConsolidationModelOutput(extractionJson(text), input, { habitsOnly: true });
		},
	};
}
