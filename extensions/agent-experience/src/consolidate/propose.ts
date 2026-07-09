import { containsUnredactedSensitiveText } from "../storage/redaction.ts";
import type { ValidatedObservationRecord } from "./observations.ts";
import { validateModelOutputBatch, type ValidatedModelOutputBatch } from "./model-output.ts";
import { GENERALIZED_HABIT_INSTRUCTIONS } from "./prompt.ts";

export interface ProposalModelRequest {
	model: string;
	payload: unknown;
	timeout_ms: number;
}

export interface ProposeFromObservationsInput {
	userId: string;
	model: string;
	observations: ValidatedObservationRecord[];
	callModel: (request: ProposalModelRequest) => Promise<unknown> | unknown;
	batchMax?: number;
	timeoutMs?: number;
}

function assertConsolidationModel(model: string): string {
	if (model !== "openai-codex/gpt-5.5") throw new Error("Unsupported consolidation model");
	return model;
}

function assertRedactedObservation(record: ValidatedObservationRecord): void {
	if (containsUnredactedSensitiveText(record.payload_redacted)) throw new Error("Observation payload contains unredacted sensitive text");
}

function buildModelPayload(input: { userId: string; model: string; observations: ValidatedObservationRecord[] }) {
	return {
		schema_version: 1,
		user_id: input.userId,
		model: input.model,
		contract: "agent_experience_model_output_v1",
		instructions: [
			"Return strict JSON only.",
			"Use only the provided redacted observations.",
			...GENERALIZED_HABIT_INSTRUCTIONS,
			"Do not include raw user or assistant text beyond redacted payload summaries.",
			"Use schema_version=1 and exact fields documented by the contract.",
		],
		observations: input.observations.map((record) => ({
			file_generation: record.file_generation,
			seq: record.seq,
			checksum: record.checksum,
			created_at: record.created_at,
			payload_redacted: record.payload_redacted,
		})),
	};
}

function parseModelResponse(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		throw new Error("Invalid model JSON output");
	}
}

export async function proposeFromObservations(input: ProposeFromObservationsInput): Promise<ValidatedModelOutputBatch> {
	const model = assertConsolidationModel(input.model);
	const batchMax = input.batchMax ?? 200;
	if (!Number.isInteger(batchMax) || batchMax < 1 || batchMax > 200) throw new Error("Invalid proposal batch cap");
	if (!Array.isArray(input.observations) || input.observations.length < 1 || input.observations.length > batchMax) throw new Error("Invalid proposal observation batch");
	for (const record of input.observations) assertRedactedObservation(record);
	const payload = buildModelPayload({ userId: input.userId, model, observations: input.observations });
	if (containsUnredactedSensitiveText(payload)) throw new Error("Model payload contains unredacted sensitive text");
	const raw = await input.callModel({ model, payload, timeout_ms: input.timeoutMs ?? 1500 });
	return validateModelOutputBatch(parseModelResponse(raw), input.userId);
}

export const buildProposalModelPayloadForTest = buildModelPayload;
