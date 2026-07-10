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
}

function parseJson(value: unknown): any {
	try { return JSON.parse(String(value || "{}")); } catch { return {}; }
}

function normalizeText(value: unknown): string {
	return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function uniqueRefs(data: any): number {
	const refs = Array.isArray(data?.source_refs) ? data.source_refs : [];
	return new Set(refs.map((ref: any) => `${ref?.file_generation}:${ref?.seq}:${ref?.checksum}`)).size;
}

function sourceDates(data: any): string[] {
	const dates = Array.isArray(data?.source_dates) ? data.source_dates : [];
	return [...new Set(dates.map((date: unknown) => String(date).slice(0, 10)).filter((date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort().slice(-30);
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
		}) as CompactHabitContextItem;
	});
}

export function compactContextIdentity(value: { condition: unknown; behavior: unknown; polarity: unknown }): string {
	return `${normalizeText(value.condition)}\n${normalizeText(value.behavior)}\n${Number(value.polarity)}`;
}
