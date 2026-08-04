import { Text, type Component } from "@earendil-works/pi-tui";
import { containsUnredactedSensitiveText, redactText } from "../storage/redaction.ts";
import type { AcceptedAdvisorFinding, AdvisorSeverity, AdvisorUpdate } from "./types.ts";

export const ADVISOR_FINDING_MESSAGE_TYPE = "agent_experience.advisor_finding";
export const ADVISOR_FINDING_VISIBLE_ENTRY_TYPE = "agent_experience.advisor_finding_visible";
export const ADVISOR_FINDING_SCHEMA_VERSION = 1;

const MAX_GENERIC_NOTE_CHARS = 1_200;
const MAX_HABIT_FIELD_CHARS = 1_000;

export type AdvisorFindingDetails =
	| {
			schema_version: 1;
			kind: "generic_advice";
			severity: AdvisorSeverity;
			note: string;
			created_at: string;
	  }
	| {
			schema_version: 1;
			kind: "habit_violation";
			severity: AdvisorSeverity;
			condition: string;
			behavior: string;
			created_at: string;
	  };

export interface AdvisorDeliveryInput {
	severity: AdvisorSeverity;
	active: boolean;
	idle: boolean;
	cancelled: boolean;
	terminal: boolean;
	planMode: "off" | "on" | "ambiguous";
	canSteer: boolean;
	canAppendMessage: boolean;
	canAppendVisible: boolean;
	immuneTurnsRemaining: number;
	shuttingDown: boolean;
}

export type AdvisorDeliveryDecision = {
	mode: "steer" | "append_when_settled" | "append_now" | "visible_fallback";
};

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
	if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
		throw new Error("Invalid Advisor finding fields");
	}
}

function severity(value: unknown): AdvisorSeverity {
	if (value !== "nit" && value !== "concern" && value !== "blocker") {
		throw new Error("Invalid Advisor finding severity");
	}
	return value;
}

function exactIso(value: unknown): string {
	if (typeof value !== "string" || !value) throw new Error("Invalid Advisor finding timestamp");
	const parsed = new Date(value);
	if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
		throw new Error("Invalid Advisor finding timestamp");
	}
	return value;
}

function safeGenericNote(value: unknown): string {
	if (typeof value !== "string") throw new Error("Invalid Advisor finding note");
	const normalized = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ").trim();
	if (!normalized || normalized.length > MAX_GENERIC_NOTE_CHARS) {
		throw new Error("Invalid Advisor finding note");
	}
	const sanitized = redactText(normalized);
	if (!sanitized || sanitized.length > MAX_GENERIC_NOTE_CHARS || containsUnredactedSensitiveText(sanitized)) {
		throw new Error("Invalid Advisor finding note");
	}
	return sanitized;
}

function exactHabitWording(value: unknown): string {
	if (typeof value !== "string" || value.length < 1 || value.length > MAX_HABIT_FIELD_CHARS) {
		throw new Error("Invalid Advisor habit wording");
	}
	if (value.trim() !== value || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
		throw new Error("Invalid Advisor habit wording");
	}
	if (redactText(value) !== value || containsUnredactedSensitiveText(value)) {
		throw new Error("Invalid Advisor habit wording");
	}
	return value;
}

export function validateAdvisorFindingDetails(value: unknown): AdvisorFindingDetails {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid Advisor finding details");
	}
	const input = value as Record<string, unknown>;
	if (input.schema_version !== ADVISOR_FINDING_SCHEMA_VERSION) {
		throw new Error("Invalid Advisor finding schema version");
	}
	const validatedSeverity = severity(input.severity);
	const createdAt = exactIso(input.created_at);
	if (input.kind === "generic_advice") {
		exactKeys(input, ["schema_version", "kind", "severity", "note", "created_at"]);
		return {
			schema_version: ADVISOR_FINDING_SCHEMA_VERSION,
			kind: "generic_advice",
			severity: validatedSeverity,
			note: safeGenericNote(input.note),
			created_at: createdAt,
		};
	}
	if (input.kind === "habit_violation") {
		exactKeys(input, ["schema_version", "kind", "severity", "condition", "behavior", "created_at"]);
		return {
			schema_version: ADVISOR_FINDING_SCHEMA_VERSION,
			kind: "habit_violation",
			severity: validatedSeverity,
			condition: exactHabitWording(input.condition),
			behavior: exactHabitWording(input.behavior),
			created_at: createdAt,
		};
	}
	throw new Error("Invalid Advisor finding kind");
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function modelVisibleContent(details: AdvisorFindingDetails): string {
	if (details.kind === "generic_advice") {
		return `<advisory severity="${details.severity}" guidance="weigh, don&apos;t blindly obey">${escapeXml(details.note)}</advisory>`;
	}
	return `<advisory severity="${details.severity}" provenance="approved Experience habit"><condition>${escapeXml(details.condition)}</condition><behavior>${escapeXml(details.behavior)}</behavior><next_step>${escapeXml(details.behavior)}</next_step></advisory>`;
}

export interface AdvisorCustomMessage {
	customType: typeof ADVISOR_FINDING_MESSAGE_TYPE;
	content: string;
	display: true;
	details: AdvisorFindingDetails;
}


export function buildAdvisorCustomMessage(
	finding: AcceptedAdvisorFinding,
	_update: AdvisorUpdate,
): AdvisorCustomMessage {
	const createdAt = new Date(Date.now()).toISOString();
	const details = finding.kind === "generic_advice"
		? validateAdvisorFindingDetails({
			schema_version: ADVISOR_FINDING_SCHEMA_VERSION,
			kind: "generic_advice",
			severity: finding.severity,
			note: finding.note,
			created_at: createdAt,
		})
		: validateAdvisorFindingDetails({
			schema_version: ADVISOR_FINDING_SCHEMA_VERSION,
			kind: "habit_violation",
			severity: finding.severity,
			condition: finding.candidate.condition,
			behavior: finding.candidate.behavior,
			created_at: createdAt,
		});
	return {
		customType: ADVISOR_FINDING_MESSAGE_TYPE,
		content: modelVisibleContent(details),
		display: true,
		details,
	};
}

function formatAdvisorFinding(details: AdvisorFindingDetails, expanded: boolean): string {
	if (details.kind === "generic_advice") {
		const title = `◇ Advisor · ${details.severity}`;
		return expanded ? `${title}\n  ${details.note}` : `${title} · ${details.note}`;
	}
	const title = `◇ Experience · habit violation · ${details.severity}`;
	if (!expanded) return `${title} · ${details.behavior}`;
	return [
		title,
		`  When: ${details.condition}`,
		`  Do: ${details.behavior}`,
		`  Next step: ${details.behavior}`,
	].join("\n");
}

export function renderAdvisorFinding(
	message: { details?: unknown },
	options: { expanded: boolean },
	theme: { fg(name: string, text: string): string },
): Component {
	try {
		const details = validateAdvisorFindingDetails(message.details);
		const color = details.severity === "blocker" ? "error" : details.severity === "concern" ? "warning" : "dim";
		return new Text(theme.fg(color, formatAdvisorFinding(details, options.expanded)), 0, 0);
	} catch {
		return new Text(theme.fg("dim", "◇ Advisor finding unavailable"), 0, 0);
	}
}

export function renderAdvisorVisibleFinding(
	value: unknown,
	options: { expanded: boolean },
	theme: { fg(name: string, text: string): string },
): Component {
	return renderAdvisorFinding({ details: value }, options, theme);
}

export function chooseAdvisorDelivery(input: AdvisorDeliveryInput): AdvisorDeliveryDecision {
	if (input.shuttingDown || (!input.canAppendMessage && !input.canSteer)) {
		return { mode: "visible_fallback" };
	}
	if (input.idle || !input.active) {
		return input.canAppendMessage ? { mode: "append_now" } : { mode: "visible_fallback" };
	}
	const steerable =
		input.canSteer &&
		(input.severity === "concern" || input.severity === "blocker") &&
		!input.cancelled &&
		!input.terminal &&
		input.planMode === "off" &&
		input.immuneTurnsRemaining <= 0;
	if (steerable) return { mode: "steer" };
	if (input.canAppendMessage) return { mode: "append_when_settled" };
	return input.canAppendVisible ? { mode: "visible_fallback" } : { mode: "append_when_settled" };
}
