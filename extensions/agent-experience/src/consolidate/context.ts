import { normalizeUserId } from "../storage/private-root.ts";
import { redactJson } from "../storage/redaction.ts";

export interface CompactHabitContextItem {
	condition: string;
	behavior: string;
	polarity: number;
	status: string;
	review_status: string | null;
	confidence_bp: number;
	unique_observations: number;
	distinct_days: number;
	source_dates: string[];
	advisor_event_fingerprints?: string[];
}

function parseJson(value: unknown): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(String(value || "{}"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

function normalizeText(value: unknown): string {
	return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function refKey(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const ref = value as Record<string, unknown>;
	if (typeof ref.file_generation !== "string" || !Number.isInteger(ref.seq) || typeof ref.checksum !== "string") return undefined;
	return `${ref.file_generation}:${ref.seq}:${ref.checksum}`;
}

function advisorEvents(data: Record<string, unknown>): Array<{ event_fingerprint: string; created_at: string }> {
	const values = Array.isArray(data.advisor_events) ? data.advisor_events : [];
	const events = new Map<string, { event_fingerprint: string; created_at: string }>();
	for (const value of values) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const event = value as Record<string, unknown>;
		if (typeof event.event_fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(event.event_fingerprint)) continue;
		if (typeof event.created_at !== "string" || !Number.isFinite(Date.parse(event.created_at))) continue;
		if (!events.has(event.event_fingerprint)) events.set(event.event_fingerprint, { event_fingerprint: event.event_fingerprint, created_at: event.created_at });
	}
	return [...events.values()];
}

function stringValues(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const strings: string[] = [];
	for (const item of value) {
		if (typeof item === "string") strings.push(item);
	}
	return strings;
}

function uniqueRefs(data: Record<string, unknown>): number {
	const refs = Array.isArray(data.source_refs) ? data.source_refs : [];
	const advisorRefKeys = new Set(stringValues(data.advisor_source_ref_keys));
	const nonAdvisorRefs = new Set(refs.map(refKey).filter((key): key is string => !!key && !advisorRefKeys.has(key)));
	return nonAdvisorRefs.size + advisorEvents(data).length;
}

function sourceDates(data: Record<string, unknown>): string[] {
	const hasAdvisorMetadata = Object.prototype.hasOwnProperty.call(data, "advisor_events")
		|| Object.prototype.hasOwnProperty.call(data, "advisor_source_ref_keys");
	const dates = hasAdvisorMetadata
		? [...stringValues(data.non_advisor_source_dates), ...advisorEvents(data).map((event) => event.created_at)]
		: stringValues(data.source_dates);
	return [...new Set(dates.map((date) => date.slice(0, 10)).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort().slice(-30);
}

export function buildCompactHabitContext(db: any, input: { userId?: string; limit?: number }): CompactHabitContextItem[] {
	const userId = normalizeUserId(input.userId);
	const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 60)));
	const rows = db.prepare("SELECT condition, behavior, polarity, status, confidence_bp, data_json FROM habits WHERE user_id = ? AND status IN ('candidate','active','disabled','dormant','suppressed_by_law') ORDER BY updated_at DESC, id LIMIT ?").all(userId, limit);
	return rows.map((row: any) => {
		const data = parseJson(row.data_json);
		const dates = sourceDates(data);
		return redactJson({
			condition: String(row.condition || "").slice(0, 1000),
			behavior: String(row.behavior || "").slice(0, 1000),
			polarity: Number(row.polarity),
			status: String(row.status),
			review_status: typeof data.review_status === "string" ? data.review_status : null,
			confidence_bp: Number(row.confidence_bp),
			unique_observations: uniqueRefs(data),
			distinct_days: dates.length,
			source_dates: dates,
			advisor_event_fingerprints: advisorEvents(data).map((event) => event.event_fingerprint),
		}) as CompactHabitContextItem;
	});
}

export function compactContextIdentity(value: { condition: unknown; behavior: unknown; polarity: unknown }): string {
	return `${normalizeText(value.condition)}\n${normalizeText(value.behavior)}\n${Number(value.polarity)}`;
}
