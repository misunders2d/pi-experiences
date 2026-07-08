import { canonicalJson } from "./storage/checksum.ts";
import { normalizeUserId } from "./storage/private-root.ts";

function parseJson(text: unknown): any {
	try { return JSON.parse(String(text || "{}")); } catch { return {}; }
}

function tableCount(db: any, table: string, where = "", args: unknown[] = []): number {
	return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get(...args).count);
}

export function collectAgentExperienceMetrics(db: any, input: { userId: string; staleThreshold?: number }) {
	const userId = normalizeUserId(input.userId);
	const staleThreshold = Number.isFinite(input.staleThreshold) ? Number(input.staleThreshold) : 0.8;
	const hitRows = db.prepare("SELECT action, selected, reason, data_json FROM selector_hit_log WHERE user_id = ? ORDER BY created_at, id").all(userId);
	const selectorByMode: Record<string, { inject: number; skip: number }> = {};
	let staleHits = 0;
	let injectHits = 0;
	for (const row of hitRows) {
		const data = parseJson(row.data_json);
		const mode = typeof data.mode === "string" ? data.mode : (data.model === "lexical" ? "instant" : "smart");
		selectorByMode[mode] ||= { inject: 0, skip: 0 };
		if (row.action === "inject" && Number(row.selected) === 1) {
			selectorByMode[mode].inject += 1;
			injectHits += 1;
			if (Number(data.staleness ?? 0) > staleThreshold) staleHits += 1;
		} else if (row.action === "skip") {
			selectorByMode[mode].skip += 1;
		}
	}
	const quarantine = tableCount(db, "model_output_quarantine", "WHERE user_id = ?", [userId]);
	const pendingReview = tableCount(db, "pending_review", "WHERE user_id = ? AND status = 'open'", [userId]);
	const audits = db.prepare("SELECT action, COUNT(*) AS count FROM consolidation_audit WHERE user_id = ? GROUP BY action ORDER BY action").all(userId);
	return {
		user_id: userId,
		selector_hits_by_mode: selectorByMode,
		stale_hit_rate: injectHits ? staleHits / injectHits : 0,
		skip_timeout_no_injection_counts: "unavailable_without_aggregate_metrics_table",
		quarantine_count: quarantine,
		pending_review_count: pendingReview,
		consolidation_outcomes: Object.fromEntries(audits.map((row: any) => [row.action, Number(row.count)])),
	};
}

export function formatAgentExperienceMetrics(metrics: ReturnType<typeof collectAgentExperienceMetrics>): string {
	const text = canonicalJson(metrics);
	return `Agent Experience metrics (redacted aggregate only):\n${text}`;
}
