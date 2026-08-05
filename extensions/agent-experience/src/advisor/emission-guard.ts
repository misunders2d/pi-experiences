import type { AdvisorAttempt, AdvisorUpdate } from "./types.ts";

const RING_CAPACITY = 4_096;
const HABIT_ALIAS = /^h[1-8]$/;

function normalize(value: string): string {
	return value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function validHabitAttempt(value: unknown, habitAliases: Set<string>): value is AdvisorAttempt {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const attempt = value as Record<string, unknown>;
	if (Object.keys(attempt).sort().join(",") !== "habitAlias,kind,severity") return false;
	return attempt.kind === "habit_violation"
		&& typeof attempt.habitAlias === "string"
		&& HABIT_ALIAS.test(attempt.habitAlias)
		&& habitAliases.has(attempt.habitAlias)
		&& (attempt.severity === "concern" || attempt.severity === "blocker");
}

function attemptKey(attempt: AdvisorAttempt, eventFingerprint: string): string {
	return `${eventFingerprint}:${normalize(`habit:${attempt.severity}:${attempt.habitAlias}`)}`;
}

function severityRank(severity: string): number {
	return severity === "blocker" ? 2 : 1;
}

export class AdvisorEmissionGuard {
	private readonly attemptRing: string[] = [];
	private attemptRingCursor = 0;
	private readonly seenEventFingerprints: string[] = [];
	private seenEventCursor = 0;
	private consumedEventFingerprint: string | undefined;

	select(attempts: AdvisorAttempt[], update: AdvisorUpdate): AdvisorAttempt | undefined {
		if (
			this.consumedEventFingerprint === update.eventFingerprint ||
			this.seenEventFingerprints.includes(update.eventFingerprint)
		) return undefined;
		if (!Array.isArray(attempts) || attempts.length === 0) return undefined;

		const habitAliases = new Set(update.habits.map((habit) => habit.alias));
		const validAttempts = attempts.filter((attempt) => {
			if (!validHabitAttempt(attempt, habitAliases)) return false;
			return !this.attemptRing.includes(attemptKey(attempt, update.eventFingerprint));
		});
		if (validAttempts.length === 0) return undefined;

		validAttempts.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
		return validAttempts[0];
	}

	commit(attempt: AdvisorAttempt, update: AdvisorUpdate): void {
		const habitAliases = new Set(update.habits.map((habit) => habit.alias));
		if (!validHabitAttempt(attempt, habitAliases)) throw new Error("Invalid Advisor habit attempt");
		const key = attemptKey(attempt, update.eventFingerprint);
		if (!this.attemptRing.includes(key)) {
			this.attemptRing[this.attemptRingCursor] = key;
			this.attemptRingCursor = (this.attemptRingCursor + 1) % RING_CAPACITY;
		}
		if (!this.seenEventFingerprints.includes(update.eventFingerprint)) {
			this.seenEventFingerprints[this.seenEventCursor] = update.eventFingerprint;
			this.seenEventCursor = (this.seenEventCursor + 1) % RING_CAPACITY;
		}
		this.consumedEventFingerprint = update.eventFingerprint;
	}

	accept(attempts: AdvisorAttempt[], update: AdvisorUpdate): AdvisorAttempt | undefined {
		const selected = this.select(attempts, update);
		if (!selected) return undefined;
		this.commit(selected, update);
		return selected;
	}

	resetForUpdate(): void {
		this.consumedEventFingerprint = undefined;
	}

	clear(): void {
		this.attemptRing.length = 0;
		this.attemptRingCursor = 0;
		this.seenEventFingerprints.length = 0;
		this.seenEventCursor = 0;
		this.consumedEventFingerprint = undefined;
	}
}
