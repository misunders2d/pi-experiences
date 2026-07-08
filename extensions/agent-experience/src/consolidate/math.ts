export interface StalenessInput {
	daysSinceLastAffirmation: number;
	recentContradictionCount: number;
	lambda?: number;
	k?: number;
}

export function calculateStaleness(input: StalenessInput): number {
	const lambda = input.lambda ?? 0.05;
	const k = input.k ?? 1.0;
	if (!(lambda > 0 && lambda < 1)) throw new Error("Invalid staleness lambda");
	if (!(k >= 0)) throw new Error("Invalid staleness k");
	if (!Number.isFinite(input.daysSinceLastAffirmation)) throw new Error("Invalid daysSinceLastAffirmation");
	if (!Number.isFinite(input.recentContradictionCount)) throw new Error("Invalid recentContradictionCount");
	const days = Math.max(0, Math.floor(input.daysSinceLastAffirmation));
	const contradictions = Math.max(0, Math.floor(input.recentContradictionCount));
	const survival = Math.pow(1 - lambda, days) / (1 + k * contradictions);
	const staleness = 1 - survival;
	return Math.min(Math.max(staleness, 0), 1 - Number.EPSILON);
}

export interface EvidenceForMath {
	polarity: 1 | -1;
	confidence_bp: number;
	observed_at: string;
}

function utcDay(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error("Invalid evidence date");
	return date.toISOString().slice(0, 10);
}

export function recentContradictionCount(evidence: EvidenceForMath[]): number {
	let lastStrongAffirmationMs = -Infinity;
	for (const item of evidence) {
		const ms = Date.parse(item.observed_at);
		if (Number.isNaN(ms)) throw new Error("Invalid evidence date");
		if (item.polarity === 1 && item.confidence_bp >= 7500 && ms > lastStrongAffirmationMs) lastStrongAffirmationMs = ms;
	}
	const contradictionDays = new Set<string>();
	for (const item of evidence) {
		const ms = Date.parse(item.observed_at);
		if (item.polarity === -1 && ms > lastStrongAffirmationMs) contradictionDays.add(utcDay(item.observed_at));
	}
	return contradictionDays.size;
}

export function hasRepetitionEligibility(sourceDates: string[]): boolean {
	if (sourceDates.length < 3) return false;
	const days = new Set(sourceDates.map(utcDay));
	return days.size >= 2;
}
