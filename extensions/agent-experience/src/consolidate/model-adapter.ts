import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compactContextIdentity, type CompactHabitContextItem } from "./context.ts";
import type { ValidatedObservationRecord } from "./observations.ts";
import { GENERALIZED_HABIT_INSTRUCTIONS } from "./prompt.ts";
import { redactText } from "../storage/redaction.ts";

export interface ConsolidationModelAdapterInput {
	model: string;
	userId: string;
	observations: ValidatedObservationRecord[];
	habitContext: CompactHabitContextItem[];
	expected: { file_generation: string; seq_start: number; seq_end: number; read_checksum: string };
	signal?: AbortSignal;
}

export interface ConsolidationModelAdapter {
	generate(input: ConsolidationModelAdapterInput): Promise<unknown>;
}

function parseProviderModel(value: string): { provider: string; modelId: string } | undefined {
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

function observationsForModelPrompt(observations: ValidatedObservationRecord[]): unknown[] {
	return observations.map((record) => {
		const payload = record.payload_redacted as any;
		return {
			seq: record.seq,
			checksum: record.checksum,
			created_at: record.created_at,
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
			source_refs: [{ file_generation: fileGeneration, seq: 1, checksum: "..." }],
			evidence_summary: "short redacted summary",
			ambiguous: false,
		}],
	};
	return [
		"You are Agent Experience habit learning.",
		"Return JSON only. No prose. No markdown unless JSON object only.",
		"Infer durable user preferences/corrections from redacted user/assistant examples.",
		"Only propose habits supported by the provided examples. Do not invent facts.",
		"Do not include secrets, emails, phone numbers, file paths, tokens, raw prompts, or private identifiers.",
		"Prefer 1-6 concise candidate habits. Return zero proposals if evidence is weak.",
		"Only propose repeated patterns: use compact existing habit context plus the new unread examples. Cite source_refs only from the new examples provided in this request.",
		"A repeated habit needs at least 3 total supporting examples across at least 2 days, combining existing_habit_context counts with new source_refs. Reuse the same normalized condition/behavior/polarity wording when adding evidence to an existing identity.",
		"Similar meanings in different wording or languages may support the same habit; cite each new matching example separately.",
		...GENERALIZED_HABIT_INSTRUCTIONS,
		"Every proposal must cite source_refs using only provided seq/checksum values.",
		"Exact output schema:",
		JSON.stringify(outputSchema),
	].join("\n");
}

export function buildConsolidationUserPrompt(input: ConsolidationModelAdapterInput): string {
	return JSON.stringify({
		task: "Analyze these redacted examples and produce reviewable habit suggestions.",
		user_id: input.userId,
		file_generation: input.expected.file_generation,
		model: input.model,
		created_at: new Date().toISOString(),
		observations_read: { seq_start: input.expected.seq_start, seq_end: input.expected.seq_end, checksum: input.expected.read_checksum },
		existing_habit_context: input.habitContext || [],
		observations: observationsForModelPrompt(input.observations),
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

function newEvidenceStats(refs: { seq: number }[], input: ConsolidationModelAdapterInput) {
	const bySeq = new Map(input.observations.map((record) => [record.seq, record]));
	const uniqueSeqs = [...new Set(refs.map((ref) => ref.seq))];
	const days = new Set(uniqueSeqs.map((seq) => bySeq.get(seq)?.created_at).filter(Boolean).map((iso) => new Date(String(iso)).toISOString().slice(0, 10)));
	return { count: uniqueSeqs.length, days };
}

function matchingHabitContext(input: ConsolidationModelAdapterInput, candidate: { condition: unknown; behavior: unknown; polarity: unknown }): CompactHabitContextItem | undefined {
	const identity = compactContextIdentity(candidate);
	return (input.habitContext || []).find((item) => compactContextIdentity(item) === identity);
}

function hasEnoughRepeatedEvidence(refs: { seq: number }[], input: ConsolidationModelAdapterInput, candidate: { condition: unknown; behavior: unknown; polarity: unknown }): boolean {
	const fresh = newEvidenceStats(refs, input);
	const existing = matchingHabitContext(input, candidate);
	const days = new Set([...(existing?.source_dates || []), ...fresh.days]);
	return fresh.count + Number(existing?.unique_observations || 0) >= 3 && days.size >= 2;
}

function normalizeConfidence(value: unknown): number {
	if (!Number.isInteger(value) || value < 0 || value > 10000) throw new Error("habit_learning_model_invalid_confidence");
	return value;
}

export function normalizeConsolidationModelOutput(raw: any, input: ConsolidationModelAdapterInput): unknown {
	const proposals = Array.isArray(raw?.proposals) ? raw.proposals.slice(0, 50).flatMap((proposal: any) => {
		const source_refs = normalizeSourceRefs(proposal?.source_refs, input);
		if (proposal?.kind === "correction_split") {
			const old_condition = requireNonEmptyString(proposal.old_condition, "old_condition");
			const old_behavior = requireNonEmptyString(proposal.old_behavior, "old_behavior");
			const new_condition = requireNonEmptyString(proposal.new_condition, "new_condition");
			const new_behavior = requireNonEmptyString(proposal.new_behavior, "new_behavior");
			const confidence_bp = normalizeConfidence(proposal.confidence_bp);
			const repeatedReplacement = hasEnoughRepeatedEvidence(source_refs, input, { condition: new_condition, behavior: new_behavior, polarity: 1 });
			const oldContext = matchingHabitContext(input, { condition: old_condition, behavior: old_behavior, polarity: 1 });
			const explicitCorrection = confidence_bp >= 8500 && source_refs.length >= 1 && oldContext?.status === "active";
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
			ambiguous: proposal.ambiguous === true,
		}];
	}) : [];
	return {
		schema_version: 1,
		user_id: input.userId,
		file_generation: input.expected.file_generation,
		batch_id: String(raw?.batch_id || `manual-${Date.now()}`),
		model: input.model,
		created_at: new Date().toISOString(),
		observations_read: { seq_start: input.expected.seq_start, seq_end: input.expected.seq_end, checksum: input.expected.read_checksum },
		proposals,
	};
}

export function __normalizeAgentExperienceConsolidationModelOutputForTest(raw: any, input: ConsolidationModelAdapterInput): unknown {
	return normalizeConsolidationModelOutput(raw, input);
}

export function __buildAgentExperienceConsolidationSystemPromptForTest(fileGeneration = "active"): string {
	return buildConsolidationSystemPrompt(fileGeneration);
}

export function createPiConsolidationModelAdapter(ctx: Pick<ExtensionContext, "modelRegistry" | "signal">, purpose = "agent-experience-manual-habit-learning"): ConsolidationModelAdapter {
	return {
		async generate(input) {
			const parsed = parseProviderModel(input.model);
			if (!parsed) throw new Error("habit_learning_model_invalid");
			const model = ctx.modelRegistry?.find?.(parsed.provider, parsed.modelId);
			if (!model) throw new Error("habit_learning_model_unavailable");
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) throw new Error("habit_learning_model_auth_unavailable");
			const response = await completeSimple(model, {
				systemPrompt: buildConsolidationSystemPrompt(input.expected.file_generation),
				messages: [{ role: "user", content: buildConsolidationUserPrompt(input), timestamp: Date.now() }],
			}, {
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal: input.signal ?? ctx.signal,
				timeoutMs: 120000,
				maxRetries: 0,
				maxRetryDelayMs: 0,
				maxTokens: 4096,
				metadata: { purpose },
			} as any);
			if ((response as any)?.stopReason === "length") throw new Error("habit_learning_model_truncated_response");
			const text = extractAssistantText(response);
			if (!text.trim()) throw new Error("habit_learning_model_empty_response");
			return normalizeConsolidationModelOutput(extractionJson(text), input);
		},
	};
}


export async function validateStandaloneConsolidationModel(configured: string): Promise<{ ok: true } | { ok: false; reason: string }> {
	const parsed = parseProviderModel(configured);
	if (!parsed) return { ok: false, reason: "invalid provider/model id" };
	try {
		const authStorage = AuthStorage.create();
		const modelRegistry = ModelRegistry.create(authStorage);
		const model = modelRegistry.find(parsed.provider, parsed.modelId);
		if (!model) return { ok: false, reason: "model is unavailable to the standalone scheduler" };
		if (!modelRegistry.hasConfiguredAuth(model)) return { ok: false, reason: "model authentication is not configured" };
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) return { ok: false, reason: "model authentication is unavailable" };
		return { ok: true };
	} catch (error: any) {
		return { ok: false, reason: redactText(String(error?.message || error)).slice(0, 180) };
	}
}

export function createStandaloneConsolidationModelAdapter(options: { signal?: AbortSignal } = {}): ConsolidationModelAdapter {
	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage);
	return createPiConsolidationModelAdapter({ modelRegistry, signal: options.signal } as Pick<ExtensionContext, "modelRegistry" | "signal">, "agent-experience-scheduled-habit-learning");
}
