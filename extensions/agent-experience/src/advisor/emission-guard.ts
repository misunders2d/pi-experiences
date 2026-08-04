import type { AdvisorAttempt, AdvisorHabitCandidate, AdvisorUpdate } from "./types.ts";

const RING_CAPACITY = 4_096;
const STOP_WORDS = new Set(["stop.", "done.", "no issue; continue."].map((w) =>
	w.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
));

function normalize(value: string): string {
	return value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function attemptKey(attempt: AdvisorAttempt): string {
	if (attempt.kind === "generic_advice") {
		return normalize(`advice:${attempt.severity}:${attempt.note}`);
	}
	return normalize(`habit:${attempt.severity}:${attempt.habitAlias}`);
}

function severityRank(severity: string): number {
	if (severity === "blocker") return 3;
	if (severity === "concern") return 2;
	return 1;
}

function isStopWord(note: string): boolean {
	return STOP_WORDS.has(normalize(note));
}

export class AdvisorEmissionGuard {
	private readonly ring: string[] = [];
	private ringCursor = 0;
	private updateConsumed = false;
	private lastEventFingerprint: string | undefined;

	accept(attempts: AdvisorAttempt[], update: AdvisorUpdate): AdvisorAttempt | undefined {
		if (this.updateConsumed) return undefined;
		if (!Array.isArray(attempts) || attempts.length === 0) return undefined;

		const habits = Array.isArray(update?.habits) ? update.habits : [];
		const habitAliases = new Set(habits.map((h: AdvisorHabitCandidate) => h.alias));

		// Validate attempts against the current update's habits
		const validAttempts = attempts.filter((attempt) => {
			const key = attemptKey(attempt);

			// Duplicate check against ring
			if (this.ring.includes(key)) return false;

			// Validate habit aliases
			if (attempt.kind === "habit_violation") {
				if (!habitAliases.has(attempt.habitAlias)) return false;
			}

			// Stop-word generic advice is suppressed
			if (attempt.kind === "generic_advice" && isStopWord(attempt.note)) return false;

			return true;
		});

		if (validAttempts.length === 0) return undefined;

		// Priority: habit violations over generic advice, then severity rank
		validAttempts.sort((a, b) => {
			const aHabit = a.kind === "habit_violation" ? 1 : 0;
			const bHabit = b.kind === "habit_violation" ? 1 : 0;
			if (aHabit !== bHabit) return bHabit - aHabit;
			return severityRank(b.severity) - severityRank(a.severity);
		});

		const selected = validAttempts[0];
		const selectedKey = attemptKey(selected);

		// Avoid re-emitting the same fingerprint in the same update
		if (update.eventFingerprint && this.lastEventFingerprint === update.eventFingerprint) {
			return undefined;
		}

		// Add to ring
		this.ring[this.ringCursor] = selectedKey;
		this.ringCursor = (this.ringCursor + 1) % RING_CAPACITY;

		this.updateConsumed = true;
		this.lastEventFingerprint = update.eventFingerprint;

		return selected;
	}

	resetForUpdate(): void {
		this.updateConsumed = false;
	}

	clear(): void {
		this.ring.length = 0;
		this.ringCursor = 0;
		this.updateConsumed = true;
		this.lastEventFingerprint = undefined;
	}
}
