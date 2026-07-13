import type { AgentExperienceConfig } from "../config.ts";
import { buildCompactHabitContext } from "../consolidate/context.ts";
import type { ConsolidationModelAdapter } from "../consolidate/model-adapter.ts";
import { getProposalReadWatermark } from "../consolidate/commit.ts";
import { expectedRangeFromObservations, runConsolidationOnce } from "../consolidate/runner.ts";
import { readConfiguredLawSnapshot } from "../review.ts";
import { createEmbeddingAdapterFromConfig, semanticPolicyFromConfig } from "../semantic/config.ts";
import type { EmbeddingAdapter } from "../semantic/types.ts";
import { promoteApprovedPendingCandidates } from "../selector.ts";
import { prepareActiveSelectorVectorsAfterChange } from "../selector-maintenance.ts";
import { acquireOwnedLock } from "../storage/locks.ts";
import { normalizeUserId } from "../storage/private-root.ts";
import { purgeExpiredObservationArchives, readCurrentObservationManifest, readValidatedObservationRange, rotateObservationGenerationIfFullyRead } from "../storage/observations.ts";
import { initExperienceStorage } from "../storage/sqlite.ts";

export type ScheduledAnalyzeCoreResult =
	| { status: "ok"; checked: number; total_unread: number; new_suggestions: number; model_proposals: number; has_more: boolean; promoted: number; promotion_blocked: number; retention_rotated: boolean }
	| { status: "no_work"; total_unread: 0; reason: "no_saved_examples" | "already_analyzed" }
	| { status: "locked" };

async function acquireAnalyzeLock(root: string) {
	try {
		return await acquireOwnedLock(root, "analyze", { waitMs: 0, staleMs: 2 * 60 * 60_000 });
	} catch (error: any) {
		if (/Could not acquire/.test(String(error?.message || error))) return undefined;
		throw error;
	}
}

export async function runScheduledAnalyzeCore(input: {
	root: string;
	userId: string;
	config: AgentExperienceConfig;
	adapterFactory: () => ConsolidationModelAdapter | Promise<ConsolidationModelAdapter>;
	signal?: AbortSignal;
	now?: () => string;
}): Promise<ScheduledAnalyzeCoreResult> {
	const userId = normalizeUserId(input.userId);
	const now = input.now || (() => new Date().toISOString());
	const lock = await acquireAnalyzeLock(input.root);
	if (!lock) return { status: "locked" };
	let storage: Awaited<ReturnType<typeof initExperienceStorage>> | undefined;
	try {
		let generation: string;
		let watermark: ReturnType<typeof getProposalReadWatermark> = null;
		let habitContext = [] as ReturnType<typeof buildCompactHabitContext>;
		try {
			storage = await initExperienceStorage(input.root, { allowInit: true, userId });
			generation = (await readCurrentObservationManifest(input.root)).file_generation;
			watermark = getProposalReadWatermark(storage.db, userId, generation);
			habitContext = buildCompactHabitContext(storage.db, { userId, limit: 60 });
		} finally {
			storage?.db.close();
			storage = undefined;
		}

		const range = await readValidatedObservationRange(input.root, {
			userId,
			afterSeq: watermark?.seq || 0,
			afterChecksum: watermark?.checksum || null,
			maxRecords: input.config.analyze_batch_max_records,
			maxBytes: input.config.analyze_batch_max_bytes,
		});
		if (range.manifest.file_generation !== generation) throw new Error("scheduled_observation_generation_changed");
		if (!range.records.length) {
			return { status: "no_work", total_unread: 0, reason: range.manifest.last_seq > 0 ? "already_analyzed" : "no_saved_examples" };
		}

		// The model adapter is deliberately created only after unread work is proven.
		const adapter = await input.adapterFactory();
		const expected = expectedRangeFromObservations(range.records, userId);
		const output = await adapter.generate({
			model: input.config.consolidation_model,
			userId,
			observations: range.records,
			habitContext,
			expected,
			signal: input.signal,
		});

		storage = await initExperienceStorage(input.root, { allowInit: true, userId });
		const result = await runConsolidationOnce({
			root: input.root,
			db: storage.db,
			userId: storage.userId,
			observations: range.records,
			modelOutput: output,
			model: input.config.consolidation_model,
			config: input.config,
			dryRun: false,
			now: now(),
		});
		if (!result.ok) throw new Error(`scheduled_model_output_invalid:${String(result.reason || "invalid")}`);

		let promoted = 0;
		let promotionBlocked = 0;
		let promotionProvider: (EmbeddingAdapter & { close?: () => Promise<void> }) | undefined;
		try {
			const policy = semanticPolicyFromConfig(input.config);
			promotionProvider = createEmbeddingAdapterFromConfig(input.config, input.root);
			const promotion = await promoteApprovedPendingCandidates(storage.db, {
				userId,
				law: await readConfiguredLawSnapshot(input.root, input.config),
				now: now(),
				semantic: { policy, provider: promotionProvider, signal: input.signal },
			});
			promoted = promotion.promoted.length;
			promotionBlocked = promotion.blocked.length;
			if (promoted) await prepareActiveSelectorVectorsAfterChange(storage.db, { root: input.root, userId, config: input.config, now: now(), signal: input.signal });
		} catch {
			// Suggestions are already atomically committed. Promotion recheck is best-effort
			// and never weakens pending/approval gates.
		} finally {
			await promotionProvider?.close?.().catch(() => undefined);
		}

		let retentionRotated = false;
		if (!range.has_more) {
			try {
				const last = range.records.at(-1)!;
				const rotation = await rotateObservationGenerationIfFullyRead(input.root, {
					userId,
					fileGeneration: last.file_generation,
					seq: last.seq,
					checksum: last.checksum,
					retentionDays: input.config.observation_retention_days,
				});
				retentionRotated = rotation.rotated;
				await purgeExpiredObservationArchives(input.root);
			} catch {
				// Suggestions remain committed; cleanup retries on a later Analyze run.
			}
		}

		const inserted = (result as any).result?.inserted || {};
		return {
			status: "ok",
			checked: range.records.length,
			total_unread: range.total_unread,
			new_suggestions: Number(inserted.candidates || 0) + Number(inserted.pending_review || 0),
			model_proposals: Number((result as any).diff?.proposal_count || 0),
			has_more: range.has_more,
			promoted,
			promotion_blocked: promotionBlocked,
			retention_rotated: retentionRotated,
		};
	} finally {
		storage?.db.close();
		// Outer Analyze lock remains held across preflight, model call, inner consolidation
		// lock, promotion recheck, and retention rotation.
		await lock.release();
	}
}

export function safeScheduledAnalyzeErrorCode(error: unknown): "model_auth_unavailable" | "model_not_found" | "model_call_failed" | "model_output_invalid" | "lock_io_error" | "storage_io_error" {
	const raw = String((error as any)?.message || error);
	if (/auth|api.?key|credential/i.test(raw)) return "model_auth_unavailable";
	if (/model_(?:unavailable|not_found)|model is not available/i.test(raw)) return "model_not_found";
	if (/model_output|invalid_json|truncated|schema|proposal|source_ref/i.test(raw)) return "model_output_invalid";
	if (/\bacquir|\bowned\b|\block\b.*(?:timeout|stale|fail|error|active|ownership|changed)/i.test(raw)) return "lock_io_error";
	if (/sqlite|storage|observation|manifest|watermark|ledger|file|directory/i.test(raw)) return "storage_io_error";
	return "model_call_failed";
}
