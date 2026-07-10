import { Text } from "@earendil-works/pi-tui";
import { containsUnredactedSensitiveText, redactText } from "./storage/redaction.ts";
import type { SelectorCandidate } from "./selector.ts";

export const HABIT_STEERING_ENTRY_TYPE = "agent_experience.habit_steering";
export const HABIT_STEERING_ENTRY_SCHEMA_VERSION = 1;
export const HABIT_STEERING_MAX_HABITS = 3;
export const HABIT_STEERING_MAX_FIELD_CHARS = 1_000;

export interface HabitSteeringEntryData {
	schema_version: 1;
	created_at: string;
	count: number;
	habits: Array<{ condition: string; behavior: string }>;
}

function exactSafeWording(value: unknown): string {
	const raw = String(value ?? "");
	if (!raw || raw.length > HABIT_STEERING_MAX_FIELD_CHARS || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw)) throw new Error("Invalid habit steering wording");
	const normalized = raw.trim().replace(/\s+/g, " ");
	if (!normalized || normalized.length > HABIT_STEERING_MAX_FIELD_CHARS) throw new Error("Invalid habit steering wording");
	if (redactText(normalized) !== normalized || containsUnredactedSensitiveText(normalized)) throw new Error("Habit steering wording is sensitive");
	return normalized;
}

function exactIso(value: unknown): string {
	const raw = String(value ?? "");
	const parsed = new Date(raw);
	if (!raw || Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== raw) throw new Error("Invalid habit steering timestamp");
	return raw;
}

export function buildHabitSteeringEntry(input: {
	candidates: SelectorCandidate[];
	selected: Array<{ id: string }>;
	createdAt: string;
}): HabitSteeringEntryData {
	if (!Array.isArray(input.selected) || input.selected.length < 1 || input.selected.length > HABIT_STEERING_MAX_HABITS) throw new Error("Invalid habit steering selection count");
	const byId = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
	const seen = new Set<string>();
	const habits = input.selected.map((selection) => {
		const id = String(selection?.id || "");
		if (!id || seen.has(id)) throw new Error("Invalid habit steering selection");
		seen.add(id);
		const candidate = byId.get(id);
		if (!candidate) throw new Error("Selected habit missing from approved candidates");
		return { condition: exactSafeWording(candidate.condition), behavior: exactSafeWording(candidate.behavior) };
	});
	if (habits.length !== input.selected.length) throw new Error("Habit steering selection mismatch");
	const entry: HabitSteeringEntryData = {
		schema_version: HABIT_STEERING_ENTRY_SCHEMA_VERSION,
		created_at: exactIso(input.createdAt),
		count: habits.length,
		habits,
	};
	if (containsUnredactedSensitiveText(entry)) throw new Error("Habit steering entry contains sensitive text");
	return entry;
}

export function validateHabitSteeringEntry(value: unknown): HabitSteeringEntryData {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid habit steering entry");
	const input = value as Record<string, unknown>;
	if (Object.keys(input).sort().join(",") !== "count,created_at,habits,schema_version") throw new Error("Invalid habit steering entry fields");
	if (input.schema_version !== HABIT_STEERING_ENTRY_SCHEMA_VERSION) throw new Error("Invalid habit steering entry version");
	if (!Array.isArray(input.habits) || input.habits.length < 1 || input.habits.length > HABIT_STEERING_MAX_HABITS || input.count !== input.habits.length) throw new Error("Invalid habit steering entry count");
	const habits = input.habits.map((habit) => {
		if (!habit || typeof habit !== "object" || Array.isArray(habit)) throw new Error("Invalid habit steering habit");
		const row = habit as Record<string, unknown>;
		if (Object.keys(row).sort().join(",") !== "behavior,condition") throw new Error("Invalid habit steering habit fields");
		return { condition: exactSafeWording(row.condition), behavior: exactSafeWording(row.behavior) };
	});
	return {
		schema_version: HABIT_STEERING_ENTRY_SCHEMA_VERSION,
		created_at: exactIso(input.created_at),
		count: habits.length,
		habits,
	};
}

export function formatHabitSteeringEntry(value: unknown, expanded: boolean): string {
	try {
		const entry = validateHabitSteeringEntry(value);
		const noun = entry.count === 1 ? "approved habit" : "approved habits";
		const lines = [`◇ Habit steering · ${entry.count} ${noun}`];
		if (expanded) {
			entry.habits.forEach((habit, index) => {
				lines.push(`${index + 1}. When: ${habit.condition}`);
				lines.push(`   Do: ${habit.behavior}`);
			});
		}
		return lines.join("\n");
	} catch {
		return "◇ Habit steering · details unavailable";
	}
}

export function renderHabitSteeringEntry(value: unknown, expanded: boolean, theme: { fg(name: string, text: string): string }) {
	return new Text(theme.fg("dim", formatHabitSteeringEntry(value, expanded)), 0, 0);
}
