import type { AdvisorAttempt, AdvisorUpdate } from "./types.ts";

const RING_CAPACITY = 4_096;
const STOP_WORDS: Record<string, true> = {
	stop: true,
	done: true,
	"no issue continue": true,
};

function normalize(value: string): string {
	return value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function attemptKey(attempt: AdvisorAttempt, eventFingerprint: string): string {
	if (attempt.kind === "generic_advice") {
		return `${eventFingerprint}:${normalize(`advice:${attempt.severity}:${attempt.note}`)}`;
	}
	return `${eventFingerprint}:${normalize(`habit:${attempt.severity}:${attempt.habitAlias}`)}`;
}

function severityRank(severity: string): number {
	if (severity === "blocker") return 3;
	if (severity === "concern") return 2;
	return 1;
}

function isStopWord(note: string): boolean {
	return STOP_WORDS[normalize(note)] === true;
}

export class AdvisorEmissionGuard {
	private readonly ring: string[] = [];
	private ringCursor = 0;
	private consumedEventFingerprint: string | undefined;
	private lastCommittedEventFingerprint: string | undefined;

	select(attempts: AdvisorAttempt[], update: AdvisorUpdate): AdvisorAttempt | undefined {
		if (
			this.consumedEventFingerprint === update.eventFingerprint ||
			this.lastCommittedEventFingerprint === update.eventFingerprint
		) return undefined;
		if (!Array.isArray(attempts) || attempts.length === 0) return undefined;

		const habitAliases = new Set(update.habits.map((habit) => habit.alias));
		const validAttempts = attempts.filter((attempt) => {
			const key = attemptKey(attempt, update.eventFingerprint);
			if (this.ring.includes(key)) return false;
			if (attempt.kind === "habit_violation" && !habitAliases.has(attempt.habitAlias)) return false;
			if (attempt.kind === "generic_advice" && isStopWord(attempt.note)) return false;
			return true;
		});
		if (validAttempts.length === 0) return undefined;

		validAttempts.sort((a, b) => {
			const aHabit = a.kind === "habit_violation" ? 1 : 0;
			const bHabit = b.kind === "habit_violation" ? 1 : 0;
			if (aHabit !== bHabit) return bHabit - aHabit;
			return severityRank(b.severity) - severityRank(a.severity);
		});
		return validAttempts[0];
	}

	commit(attempt: AdvisorAttempt, update: AdvisorUpdate): void {
		const key = attemptKey(attempt, update.eventFingerprint);
		if (!this.ring.includes(key)) {
			this.ring[this.ringCursor] = key;
			this.ringCursor = (this.ringCursor + 1) % RING_CAPACITY;
		}
		this.consumedEventFingerprint = update.eventFingerprint;
		this.lastCommittedEventFingerprint = update.eventFingerprint;
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
		this.ring.length = 0;
		this.ringCursor = 0;
		this.consumedEventFingerprint = undefined;
		this.lastCommittedEventFingerprint = undefined;
	}
}
