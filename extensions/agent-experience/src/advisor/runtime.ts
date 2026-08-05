import type { AdvisorAgentAdapter } from "./model.ts";
import type {
	AcceptedAdvisorFinding,
	AdvisorDiagnosticReason,
	AdvisorPrimaryDelta,
	AdvisorUpdate,
} from "./types.ts";
import { AdvisorEmissionGuard } from "./emission-guard.ts";
import { computeEventFingerprint } from "./transcript.ts";

export interface AdvisorRuntimeHost {
	buildUpdate(delta: AdvisorPrimaryDelta): Promise<AdvisorUpdate | undefined>;
	acceptFinding(finding: AcceptedAdvisorFinding, update: AdvisorUpdate): Promise<void>;
	onStaticDiagnostic(reason: AdvisorDiagnosticReason): void;
}

interface QueuedEnvelope {
	delta: AdvisorPrimaryDelta;
	enqueuedAt: number;
	mergedEntryIds: string[];
	mergedText: string;
}

const MAX_QUEUED_BATCHES = 5;
const CATCHUP_TIMEOUT_MS = 30_000;
const EXACT_FAILURE_DIAGNOSTICS = new Set<AdvisorDiagnosticReason>([
	"advisor_auth_unavailable",
	"advisor_context_overflow",
	"advisor_timeout",
	"advisor_unavailable",
]);

export class AdvisorRuntime {
	private readonly host: AdvisorRuntimeHost;
	private readonly adapter: AdvisorAgentAdapter;
	private readonly guard = new AdvisorEmissionGuard();
	private queue: QueuedEnvelope[] = [];
	private draining = false;
	private drainPromise: Promise<void> | undefined;
	private disposed = false;
	private generation = 0;
	private abortController: AbortController | undefined;

	constructor(host: AdvisorRuntimeHost, adapter: AdvisorAgentAdapter) {
		this.host = host;
		this.adapter = adapter;
	}

	enqueue(delta: AdvisorPrimaryDelta): void {
		if (this.disposed) return;

		// Coalesce: find existing envelope with same generation and causal episode
		const existingIndex = this.queue.findIndex(
			(e) =>
				e.delta.epoch === delta.epoch &&
				e.delta.generation === delta.generation &&
				e.delta.causalEpisodeId === delta.causalEpisodeId &&
				e.delta.scope.userId === delta.scope.userId &&
				e.delta.scope.sessionId === delta.scope.sessionId &&
				e.delta.scope.sessionFile === delta.scope.sessionFile,
		);

		if (existingIndex >= 0) {
			const existing = this.queue[existingIndex];
			// Merge review and persistence-safe evidence from the exact same causal batch.
			const mergedEntryIds = [
				...new Set([...existing.mergedEntryIds, ...delta.primaryEntryIds]),
			];
			let mergedText = `${existing.mergedText}\n${delta.text}`;
			if (mergedText.length > 24_000) mergedText = mergedText.slice(0, 24_000);
			const observationParts = [existing.delta.observationText?.trim(), delta.observationText?.trim()]
				.filter((value): value is string => !!value);
			let mergedObservationText = observationParts.join("\n");
			if (mergedObservationText.length > 3_000) mergedObservationText = mergedObservationText.slice(0, 3_000);

			const mergedDelta: AdvisorPrimaryDelta = {
				...delta,
				cursor: Math.max(existing.delta.cursor, delta.cursor),
				text: mergedText,
				observationText: mergedObservationText || undefined,
				primaryEntryIds: mergedEntryIds,
				causedByAdvisor: existing.delta.causedByAdvisor || delta.causedByAdvisor,
				toolEventCount: existing.delta.toolEventCount + delta.toolEventCount,
				eventFingerprint: computeEventFingerprint(
					delta.scope,
					mergedEntryIds,
					delta.causalEpisodeId,
					mergedText,
				),
			};

			this.queue[existingIndex] = {
				delta: mergedDelta,
				enqueuedAt: Date.now(),
				mergedEntryIds,
				mergedText,
			};
		} else {
			// Enforce max queue size
			if (this.queue.length >= MAX_QUEUED_BATCHES) {
				this.host.onStaticDiagnostic("advisor_queue_coalesced");
				return;
			}

			this.queue.push({
				delta,
				enqueuedAt: Date.now(),
				mergedEntryIds: [...delta.primaryEntryIds],
				mergedText: delta.text,
			});
		}

		if (!this.draining) this.drainPromise = this.drain();
	}

	reset(reason: string): void {
		this.generation++;
		this.abortController?.abort();
		this.abortController = undefined;
		this.queue = [];
		this.guard.clear();
		this.drainPromise = undefined;
		this.draining = false;
	}

	async waitForCatchup(): Promise<void> {
		if (!this.drainPromise) return;
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<void>((resolve) => {
			timer = setTimeout(() => { timer = undefined; resolve(); }, CATCHUP_TIMEOUT_MS);
		});
		await Promise.race([this.drainPromise, timeout]);
		clearTimeout(timer);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.abortController?.abort();
		this.queue = [];
		this.guard.clear();
		if (this.drainPromise) {
			let timer: NodeJS.Timeout | undefined;
			const timeout = new Promise<void>((resolve) => {
				timer = setTimeout(() => { timer = undefined; resolve(); }, CATCHUP_TIMEOUT_MS);
			});
			await Promise.race([this.drainPromise, timeout]);
			clearTimeout(timer);
		}
	}

	private async drain(): Promise<void> {
		if (this.draining || this.disposed || this.queue.length === 0) return;
		this.draining = true;

		try {
			while (this.queue.length > 0 && !this.disposed) {
				const currentGeneration = this.generation;

				// Create fresh abort controller for this batch
				this.abortController = new AbortController();
				const signal = this.abortController.signal;

				const envelope = this.queue.shift();
				if (!envelope) break;

				// Stale check: generation changed during drain
				if (this.generation !== currentGeneration) {
					this.abortController = undefined;
					break;
				}

				// Stale check: scope/epoch/generation must match current state
				// (The envelope captured these at enqueue time; if a reset happened, they're stale)
				const delta = envelope.delta;

				try {
					// Build update via host — check for abortion after await
					const update = await this.buildUpdateWithAbortCheck(
						delta,
						signal,
						currentGeneration,
					);
					if (!update) continue;

					// Review via adapter — check for abortion after await
					const attempts = await this.reviewWithAbortCheck(
						update,
						signal,
						currentGeneration,
					);

					if (!attempts || attempts.length === 0) continue;

					const finding = this.guard.select(attempts, update);
					if (!finding) continue;
					const accepted: AcceptedAdvisorFinding = buildAcceptedFinding(finding, update.eventFingerprint);

					if (this.generation !== currentGeneration || this.disposed || signal.aborted) break;
					await this.host.acceptFinding(accepted, update);
					if (this.generation !== currentGeneration || this.disposed || signal.aborted) break;
					this.guard.commit(finding, update);
				} catch (err) {
					// Convert failure to diagnostic; don't throw into primary loop
					if (signal.aborted || this.disposed) {
						this.host.onStaticDiagnostic("advisor_cancelled");
					} else if (err instanceof Error && EXACT_FAILURE_DIAGNOSTICS.has(err.message as AdvisorDiagnosticReason)) {
						this.host.onStaticDiagnostic(err.message as AdvisorDiagnosticReason);
					} else {
						this.host.onStaticDiagnostic("advisor_unavailable");
					}

					// On adapter failure, release primary: let remaining queue drain
					// If this was due to reset/dispose, break out
					if (this.generation !== currentGeneration || this.disposed) break;
				}
			}
		} finally {
			this.draining = false;
			this.abortController = undefined;

			// If there's more work queued, start another drain
			if (this.queue.length > 0 && !this.disposed) {
				this.drainPromise = this.drain();
			} else {
				this.drainPromise = undefined;
			}
		}
	}

	private async buildUpdateWithAbortCheck(
		delta: AdvisorPrimaryDelta,
		signal: AbortSignal,
		expectedGeneration: number,
	): Promise<AdvisorUpdate | undefined> {
		const update = await this.host.buildUpdate(delta);
		if (this.generation !== expectedGeneration || this.disposed || signal.aborted) return undefined;
		return update ?? undefined;
	}

	private async reviewWithAbortCheck(
		update: AdvisorUpdate,
		signal: AbortSignal,
		expectedGeneration: number,
	): Promise<ReturnType<AdvisorAgentAdapter["review"]>> {
		const attempts = await this.adapter.review(update, signal);
		if (this.generation !== expectedGeneration || this.disposed || signal.aborted) return [];
		return attempts;
	}
}

function buildAcceptedFinding(
	attempt: { kind: "habit_violation"; severity: "concern" | "blocker"; habitAlias: string },
	eventFingerprint: string,
): AcceptedAdvisorFinding {
	return {
		kind: "habit_violation",
		candidate: {
			alias: attempt.habitAlias,
			habitId: "",
			condition: "",
			behavior: "",
			checksum: "",
			lawHash: "",
		},
		severity: attempt.severity,
		eventFingerprint,
	};
}
