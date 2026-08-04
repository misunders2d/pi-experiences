import { createHash } from "node:crypto";
import { join } from "node:path";
import { readAgentExperienceConfig } from "../paths.ts";
import { containsUnredactedSensitiveText, redactText } from "../storage/redaction.ts";
import { appendUniqueObservation } from "../storage/observations.ts";
import type { AcceptedAdvisorFinding, AdvisorSeverity, AdvisorUpdate } from "./types.ts";

const EVENT_FINGERPRINT = /^[0-9a-f]{64}$/;
const MAX_CURRENT_REQUEST_CHARS = 1_000;
const MAX_PRIMARY_BEHAVIOR_CHARS = 3_000;
const MAX_ADVICE_CHARS = 1_200;
const MAX_PAYLOAD_CHARS = 6_000;

export interface AdvisorFindingPayloadV1 {
	kind: "advisor_finding_v1";
	finding_kind: "generic_advice" | "habit_violation";
	severity: AdvisorSeverity;
	current_request_redacted: string;
	primary_behavior_redacted: string;
	advice_redacted: string;
	event_fingerprint: string;
	primary_created_at: string;
}

export interface AppendAdvisorFindingObservationInput {
	userId?: string;
	finding: AcceptedAdvisorFinding;
	update: AdvisorUpdate;
	createdAt?: string;
	modelVisibleDelivered: boolean;
}

function assertIsoTimestamp(value: string): string {
	if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("Invalid Advisor observation timestamp");
	return value;
}

function boundedRedactedText(value: unknown, rawLimit: number, serializedLimit: number, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid Advisor observation ${field}`);
	const redacted = redactText(value.trim());
	if (containsUnredactedSensitiveText(redacted)) throw new Error(`Advisor observation ${field} contains residual sensitive text`);
	const rawBounded = redacted.slice(0, rawLimit);
	if (JSON.stringify(rawBounded).length <= serializedLimit) return rawBounded;
	let low = 0;
	let high = rawBounded.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (JSON.stringify(rawBounded.slice(0, middle)).length <= serializedLimit) low = middle;
		else high = middle - 1;
	}
	return rawBounded.slice(0, low);
}

function deterministicObservationId(eventFingerprint: string): string {
	return `advisor-${createHash("sha256").update(`advisor_finding_v1:${eventFingerprint}`).digest("hex")}`;
}

export function buildAdvisorFindingObservation(
	finding: AcceptedAdvisorFinding,
	update: AdvisorUpdate,
	createdAt: string,
): AdvisorFindingPayloadV1 {
	if (!finding || (finding.kind !== "generic_advice" && finding.kind !== "habit_violation")) throw new Error("Invalid Advisor finding kind");
	if (!EVENT_FINGERPRINT.test(finding.eventFingerprint) || finding.eventFingerprint !== update.eventFingerprint) throw new Error("Advisor finding fingerprint mismatch");
	if (finding.severity !== "nit" && finding.severity !== "concern" && finding.severity !== "blocker") throw new Error("Invalid Advisor finding severity");
	const advice = finding.kind === "generic_advice" ? finding.note : finding.candidate.behavior;
	const payload: AdvisorFindingPayloadV1 = {
		kind: "advisor_finding_v1",
		finding_kind: finding.kind,
		severity: finding.severity,
		current_request_redacted: boundedRedactedText(update.currentRequest, MAX_CURRENT_REQUEST_CHARS, 1_000, "current request"),
		primary_behavior_redacted: boundedRedactedText(update.primaryDelta, MAX_PRIMARY_BEHAVIOR_CHARS, 3_000, "primary behavior"),
		advice_redacted: boundedRedactedText(advice, MAX_ADVICE_CHARS, 1_200, "advice"),
		event_fingerprint: update.eventFingerprint,
		primary_created_at: assertIsoTimestamp(createdAt),
	};
	if (containsUnredactedSensitiveText(payload)) throw new Error("Advisor observation contains residual sensitive text");
	if (JSON.stringify(payload).length > MAX_PAYLOAD_CHARS) throw new Error("Advisor observation payload exceeds size limit");
	return payload;
}

export async function appendAdvisorFindingObservation(
	root: string,
	input: AppendAdvisorFindingObservationInput,
): Promise<{ appended: boolean; reason: string }> {
	const { config } = await readAgentExperienceConfig({ root, configPath: join(root, "agent-experience.toml") });
	if (!config.enabled || !config.capture_enabled) return { appended: false, reason: "learning_disabled" };
	if (input.modelVisibleDelivered !== true) return { appended: false, reason: "not_model_visible" };
	if (input.update.causedByAdvisor) return { appended: false, reason: "advisor_caused" };
	const createdAt = input.createdAt || new Date().toISOString();
	const payload = buildAdvisorFindingObservation(input.finding, input.update, createdAt);
	const result = await appendUniqueObservation(root, {
		userId: input.userId || input.update.scope.userId,
		origin: { source: "advisor_finding" },
		payload,
		id: deterministicObservationId(payload.event_fingerprint),
		createdAt,
		eventFingerprint: payload.event_fingerprint,
	});
	return { appended: result.appended, reason: result.reason };
}
