import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import type { AdvisorAttempt, AdvisorSeverity } from "./types.ts";

export const AdviseParameters = Type.Object({
	note: Type.String({ minLength: 1, maxLength: 1200 }),
	severity: Type.Optional(Type.Union([Type.Literal("nit"), Type.Literal("concern"), Type.Literal("blocker")])),
}, { additionalProperties: false });

export const HabitViolationParameters = Type.Object({
	habit_alias: Type.String({ pattern: "^h[1-8]$" }),
	severity: Type.Union([Type.Literal("concern"), Type.Literal("blocker")]),
}, { additionalProperties: false });

type AdviseInput = Static<typeof AdviseParameters>;
type HabitViolationInput = Static<typeof HabitViolationParameters>;

const ADVICE_SEVERITIES = new Set<AdvisorSeverity>(["nit", "concern", "blocker"]);
const HABIT_SEVERITIES = new Set<AdvisorSeverity>(["concern", "blocker"]);
const HABIT_ALIAS = /^h[1-8]$/;

export class AdvisorAttemptBuffer {
	private readonly allowedHabitAliases: Set<string>;
	private attempt: AdvisorAttempt | undefined;
	private closed = false;
	private drained = false;

	constructor(allowedHabitAliases: Iterable<string> = []) {
		this.allowedHabitAliases = new Set(allowedHabitAliases);
		for (const alias of this.allowedHabitAliases) {
			if (!HABIT_ALIAS.test(alias)) throw new Error("Invalid supplied alias for Advisor habit");
		}
	}

	private record(attempt: AdvisorAttempt): void {
		if (this.closed || this.attempt) throw new Error("Advisor emission already recorded");
		this.attempt = attempt;
	}

	async advise(input: AdviseInput): Promise<void> {
		const note = typeof input?.note === "string" ? input.note.trim() : "";
		const severity = input?.severity ?? "concern";
		if (!note || note.length > 1200) throw new Error("Invalid Advisor advice note");
		if (!ADVICE_SEVERITIES.has(severity)) throw new Error("Invalid Advisor advice severity");
		this.record({ kind: "generic_advice", note, severity });
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
		return this.attempt ? [this.attempt] : [];
	}

	clear(): void {
		this.closed = true;
		this.attempt = undefined;
	}
}

export function createAdvisorEmissionTools(buffer: AdvisorAttemptBuffer): AgentTool[] {
	return [
		{
			name: "advise",
			label: "Advise",
			description: "Record one concrete generic Advisor finding for this update.",
			parameters: AdviseParameters,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				await buffer.advise(params as AdviseInput);
				return { content: [{ type: "text", text: "Recorded." }], details: {} };
			},
		},
		{
			name: "report_habit_violation",
			label: "Report habit violation",
			description: "Record a violation of one exact approved-habit alias supplied in the current update.",
			parameters: HabitViolationParameters,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				await buffer.reportHabitViolation(params as HabitViolationInput);
				return { content: [{ type: "text", text: "Recorded." }], details: {} };
			},
		},
	];
}
