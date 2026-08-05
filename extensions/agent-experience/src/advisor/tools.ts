import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import type { AdvisorAttempt, AdvisorSeverity } from "./types.ts";

export const HabitViolationParameters = Type.Object({
	habit_alias: Type.String({ pattern: "^h[1-8]$" }),
	severity: Type.Union([Type.Literal("concern"), Type.Literal("blocker")]),
}, { additionalProperties: false });

type HabitViolationInput = Static<typeof HabitViolationParameters>;

const HABIT_SEVERITIES = new Set<AdvisorSeverity>(["concern", "blocker"]);
const HABIT_ALIAS = /^h[1-8]$/;
const MAX_ADVISOR_EMISSION_ATTEMPTS = 8;

export class AdvisorAttemptBuffer {
	private readonly allowedHabitAliases: Set<string>;
	private readonly attempts: AdvisorAttempt[] = [];
	private closed = false;
	private drained = false;

	constructor(allowedHabitAliases: Iterable<string> = []) {
		this.allowedHabitAliases = new Set(allowedHabitAliases);
		for (const alias of this.allowedHabitAliases) {
			if (!HABIT_ALIAS.test(alias)) throw new Error("Invalid supplied alias for Advisor habit");
		}
	}

	private record(attempt: AdvisorAttempt): void {
		if (this.closed) throw new Error("Advisor emission buffer is closed");
		if (this.attempts.length >= MAX_ADVISOR_EMISSION_ATTEMPTS) throw new Error("Advisor emission attempt budget exhausted");
		this.attempts.push(attempt);
	}

	async reportHabitViolation(input: HabitViolationInput): Promise<void> {
		if (!input || typeof input.habit_alias !== "string" || !HABIT_ALIAS.test(input.habit_alias)) {
			throw new Error("Invalid Advisor habit alias");
		}
		if (!HABIT_SEVERITIES.has(input.severity)) throw new Error("Invalid Advisor habit severity");
		if (!this.allowedHabitAliases.has(input.habit_alias)) throw new Error("Invalid supplied alias for Advisor habit");
		this.record({ kind: "habit_violation", habitAlias: input.habit_alias, severity: input.severity });
	}

	drain(): AdvisorAttempt[] {
		if (this.drained) return [];
		this.drained = true;
		this.closed = true;
		return this.attempts.splice(0);
	}

	clear(): void {
		this.closed = true;
		this.attempts.length = 0;
	}
}

export function createAdvisorEmissionTools(buffer: AdvisorAttemptBuffer): AgentTool[] {
	return [{
		name: "report_habit_violation",
		label: "Report habit violation",
		description: "Record a violation of one exact approved-habit alias supplied in the current update.",
		parameters: HabitViolationParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			await buffer.reportHabitViolation(params as HabitViolationInput);
			return { content: [{ type: "text", text: "Recorded." }], details: {} };
		},
	}];
}
