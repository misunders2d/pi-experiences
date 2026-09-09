import { canonicalJson, checksumJson, sha256Hex } from "../storage/checksum.ts";
import { normalizeUserId } from "../storage/private-root.ts";
import { redactJson, redactText } from "../storage/redaction.ts";
import { buildTypedStorageRow } from "../storage/sqlite.ts";
import type { ValidatedObservationRecord } from "./observations.ts";
import type { ProposalSourceRef } from "./proposals.ts";

export const EPISODE_FRONTIER_KIND = "episode_frontier_v1";
export const MAX_EPISODE_FRONTIERS_PER_USER = 64;
export const MAX_EPISODE_FRONTIERS_PER_BATCH = 16;
// Config permits at most 500 observations per batch; each can emit one statement
// plus one linked-turn unit. Keep every source represented before watermark advance.
export const MAX_SITUATION_EVIDENCE_UNITS = 1000;
const SITUATION_CHARS = 400;
const ACTION_CHARS = 600;
const FEEDBACK_CHARS = 400;
const HASH = /^[a-f0-9]{64}$/;

export type SituationEvidenceBasis = "inferred_pattern" | "explicit_durable_preference";

export interface SituationEvidenceUnit {
	evidence_unit_ref: string;
	kind: "linked_turn" | "explicit_user_statement";
	lineage_ref: string;
	independence_known: boolean;
	occurred_at: string;
	current_source_refs: ProposalSourceRef[];
	historical_source_ref?: ProposalSourceRef;
	situation_redacted?: string;
	action_redacted?: string;
	linked_user_turn_redacted?: string;
	user_statement_redacted?: string;
}

interface EpisodeFrontier {
	id: string;
	row_checksum?: string;
	lineage_ref: string;
	turn_ref: string;
	independence_known: boolean;
	source_ref: ProposalSourceRef;
	observed_at: string;
	created_at: string;
	expires_at: string;
	situation_redacted: string;
	action_redacted: string;
	frontier_checksum: string;
}

export interface EpisodeFrontierTransition {
	user_id: string;
	created_at: string;
	delete_refs: Array<{ id: string; row_checksum: string }>;
	upserts: EpisodeFrontier[];
	checksum: string;
}

export interface SituationBatch {
	schema_version: 1;
	user_id: string;
	file_generation: string;
	seq_start: number;
	seq_end: number;
	units: SituationEvidenceUnit[];
	transition: EpisodeFrontierTransition;
	checksum: string;
}

function text(value: unknown, max: number): string {
	const safe = redactText(typeof value === "string" ? value : "").trim().replace(/\s+/g, " ");
	return safe.length <= max ? safe : safe.slice(safe.length - max);
}

function sourceRef(record: ValidatedObservationRecord): ProposalSourceRef {
	return { file_generation: record.file_generation, seq: record.seq, checksum: record.checksum };
}

function causal(record: ValidatedObservationRecord): { lineage_ref: string; turn_ref: string; parent_turn_ref: string | null; independence_known: boolean } | undefined {
	const payload = record.payload_redacted as any;
	const value = payload?.kind === "conversation_pair_v1" ? payload.causal_context : undefined;
	if (!value || !HASH.test(value.lineage_ref) || !HASH.test(value.turn_ref) || (value.parent_turn_ref !== null && !HASH.test(value.parent_turn_ref)) || typeof value.independence_known !== "boolean") return undefined;
	return value;
}

function pairText(record: ValidatedObservationRecord): { user: string; assistant: string } | undefined {
	const payload = record.payload_redacted as any;
	if (payload?.kind !== "conversation_pair_v1") return undefined;
	const user = text(payload.user_text_redacted, SITUATION_CHARS);
	const assistant = text(payload.assistant_text_redacted, ACTION_CHARS);
	return user && assistant ? { user, assistant } : undefined;
}

function unitId(kind: string, value: unknown): string {
	return sha256Hex(canonicalJson({ schema: "agent_experience_evidence_unit_v1", kind, value }));
}

function frontierChecksum(value: Omit<EpisodeFrontier, "id" | "row_checksum" | "frontier_checksum">): string {
	return checksumJson({ schema: EPISODE_FRONTIER_KIND, frontier: value });
}

function parseFrontierRow(row: any): EpisodeFrontier | undefined {
	try {
		const residual = JSON.parse(String(row.data_json || "{}"));
		const data = { ...residual, record_kind: row.record_kind, schema_version: row.schema_version, status: row.status, habit_id: row.habit_id, condition: row.condition, behavior: row.behavior, polarity: row.polarity, confidence_bp: row.confidence_bp, activation: row.activation, staleness: row.staleness };
		const rebuilt = buildTypedStorageRow("contexts", { id: row.id, userId: row.user_id, data, createdAt: row.created_at, updatedAt: row.updated_at });
		if (rebuilt.checksum !== row.checksum || row.record_kind !== EPISODE_FRONTIER_KIND || row.status !== "active") return undefined;
		const base = {
			lineage_ref: residual.lineage_ref,
			turn_ref: residual.turn_ref,
			independence_known: residual.independence_known,
			source_ref: residual.source_ref,
			observed_at: residual.observed_at,
			created_at: residual.created_at,
			expires_at: residual.expires_at,
			situation_redacted: residual.situation_redacted,
			action_redacted: residual.action_redacted,
		};
		if (!HASH.test(base.lineage_ref) || !HASH.test(base.turn_ref) || typeof base.independence_known !== "boolean") return undefined;
		if (!base.source_ref || typeof base.source_ref.file_generation !== "string" || !Number.isInteger(base.source_ref.seq) || !HASH.test(base.source_ref.checksum)) return undefined;
		if (![base.observed_at, base.created_at, base.expires_at].every((value) => typeof value === "string" && Number.isFinite(Date.parse(value)))) return undefined;
		if (!base.situation_redacted || !base.action_redacted || text(base.situation_redacted, SITUATION_CHARS) !== base.situation_redacted || text(base.action_redacted, ACTION_CHARS) !== base.action_redacted) return undefined;
		if (residual.frontier_checksum !== frontierChecksum(base)) return undefined;
		return { id: row.id, row_checksum: row.checksum, ...base, frontier_checksum: residual.frontier_checksum };
	} catch {
		return undefined;
	}
}

function frontierData(frontier: EpisodeFrontier) {
	return {
		record_kind: EPISODE_FRONTIER_KIND,
		schema_version: 1,
		status: "active",
		lineage_ref: frontier.lineage_ref,
		turn_ref: frontier.turn_ref,
		independence_known: frontier.independence_known,
		source_ref: frontier.source_ref,
		observed_at: frontier.observed_at,
		created_at: frontier.created_at,
		expires_at: frontier.expires_at,
		situation_redacted: frontier.situation_redacted,
		action_redacted: frontier.action_redacted,
		frontier_checksum: frontier.frontier_checksum,
	};
}

function transitionChecksum(value: Omit<EpisodeFrontierTransition, "checksum">): string {
	return checksumJson({ schema: "agent_experience_episode_frontier_transition_v1", transition: JSON.parse(canonicalJson(value)) });
}

export function assertSituationBatch(batch: SituationBatch, input: { userId: string; fileGeneration: string; seqStart: number; seqEnd: number }): void {
	if (batch.schema_version !== 1 || batch.user_id !== normalizeUserId(input.userId) || batch.file_generation !== input.fileGeneration || batch.seq_start !== input.seqStart || batch.seq_end !== input.seqEnd) throw new Error("Situation batch range mismatch");
	const { checksum, ...without } = batch;
	if (checksum !== checksumJson({ schema: "agent_experience_situation_batch_v1", batch: JSON.parse(canonicalJson(without)) })) throw new Error("Situation batch checksum mismatch");
	const { checksum: transitionStored, ...transition } = batch.transition;
	if (transitionStored !== transitionChecksum(transition)) throw new Error("Episode frontier transition checksum mismatch");
}

export function buildSituationBatch(db: any, input: { userId: string; observations: ValidatedObservationRecord[]; retentionDays: number; now: string }): SituationBatch {
	const userId = normalizeUserId(input.userId);
	if (!input.observations.length) throw new Error("No observations for situation batch");
	if (![7, 14, 30].includes(Math.trunc(input.retentionDays))) throw new Error("Invalid situation retention");
	const nowMs = Date.parse(input.now);
	if (!Number.isFinite(nowMs)) throw new Error("Invalid situation batch time");
	const first = input.observations[0];
	const last = input.observations.at(-1)!;
	const currentActions = new Map<string, { record: ValidatedObservationRecord; causal: NonNullable<ReturnType<typeof causal>>; pair: NonNullable<ReturnType<typeof pairText>> }[]>();
	const parentRefs = new Set<string>();
	for (const record of input.observations) {
		const c = causal(record);
		const pair = pairText(record);
		if (!c || !pair || record.user_id !== userId || record.file_generation !== first.file_generation) continue;
		const list = currentActions.get(c.turn_ref) || [];
		list.push({ record, causal: c, pair });
		currentActions.set(c.turn_ref, list);
		if (c.parent_turn_ref) parentRefs.add(c.parent_turn_ref);
	}

	const rows = db.prepare(`SELECT * FROM contexts WHERE user_id = ? AND record_kind = ? ORDER BY updated_at DESC, id LIMIT ?`).all(userId, EPISODE_FRONTIER_KIND, MAX_EPISODE_FRONTIERS_PER_USER + 1);
	const invalidRefs: Array<{ id: string; row_checksum: string }> = [];
	const frontierByTurn = new Map<string, EpisodeFrontier[]>();
	for (const row of rows) {
		const frontier = parseFrontierRow(row);
		if (!frontier || Date.parse(frontier.expires_at) <= nowMs) {
			invalidRefs.push({ id: String(row.id), row_checksum: String(row.checksum) });
			continue;
		}
		if (!parentRefs.has(frontier.turn_ref)) continue;
		const list = frontierByTurn.get(frontier.turn_ref) || [];
		list.push(frontier);
		frontierByTurn.set(frontier.turn_ref, list);
	}
	const matchedFrontiers = [...frontierByTurn.values()].flat().sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_EPISODE_FRONTIERS_PER_BATCH);
	const allowedFrontierIds = new Set(matchedFrontiers.map((frontier) => frontier.id));
	for (const [turn, values] of frontierByTurn) frontierByTurn.set(turn, values.filter((value) => allowedFrontierIds.has(value.id)));

	const outcomes: SituationEvidenceUnit[] = [];
	const explicit: SituationEvidenceUnit[] = [];
	const consumedFrontierRefs = new Map<string, string>();
	for (const record of input.observations) {
		const c = causal(record);
		const pair = pairText(record);
		if (!c || !pair) continue;
		explicit.push({
			evidence_unit_ref: unitId("explicit_user_statement", { lineage_ref: c.lineage_ref, turn_ref: c.turn_ref }),
			kind: "explicit_user_statement",
			lineage_ref: c.lineage_ref,
			independence_known: c.independence_known,
			occurred_at: record.created_at,
			current_source_refs: [sourceRef(record)],
			user_statement_redacted: text(pair.user, FEEDBACK_CHARS),
		});
		if (!c.parent_turn_ref) continue;
		const currentParents = currentActions.get(c.parent_turn_ref) || [];
		const storedParents = frontierByTurn.get(c.parent_turn_ref) || [];
		const parentCount = currentParents.length + storedParents.length;
		if (parentCount !== 1) continue; // Missing or ambiguous evidence must abstain.
		const currentParent = currentParents[0];
		const storedParent = storedParents[0];
		const parentLineage = currentParent?.causal.lineage_ref ?? storedParent?.lineage_ref;
		if (parentLineage !== c.lineage_ref) continue;
		if (storedParent?.row_checksum) consumedFrontierRefs.set(storedParent.id, storedParent.row_checksum);
		const actionTurnRef = currentParent?.causal.turn_ref ?? storedParent!.turn_ref;
		outcomes.push({
			evidence_unit_ref: unitId("linked_turn", { lineage_ref: c.lineage_ref, action_turn_ref: actionTurnRef, linked_turn_ref: c.turn_ref }),
			kind: "linked_turn",
			lineage_ref: c.lineage_ref,
			independence_known: c.independence_known && (currentParent?.causal.independence_known ?? storedParent!.independence_known),
			occurred_at: record.created_at,
			current_source_refs: currentParent ? [sourceRef(currentParent.record), sourceRef(record)] : [sourceRef(record)],
			...(storedParent ? { historical_source_ref: storedParent.source_ref } : {}),
			situation_redacted: currentParent?.pair.user ?? storedParent!.situation_redacted,
			action_redacted: currentParent?.pair.assistant ?? storedParent!.action_redacted,
			linked_user_turn_redacted: text(pair.user, FEEDBACK_CHARS),
		});
	}

	const consumedTurnRefs = new Set([...currentActions.values()].flatMap((values) => values.map((value) => value.causal.parent_turn_ref)).filter((value): value is string => !!value));
	const upserts: EpisodeFrontier[] = [];
	for (const values of currentActions.values()) {
		if (values.length !== 1) continue;
		const value = values[0];
		if (consumedTurnRefs.has(value.causal.turn_ref)) continue;
		const observedMs = Date.parse(value.record.created_at);
		if (!Number.isFinite(observedMs)) continue;
		const expiresAt = new Date(observedMs + input.retentionDays * 86_400_000).toISOString();
		if (Date.parse(expiresAt) <= nowMs) continue;
		const base = {
			lineage_ref: value.causal.lineage_ref,
			turn_ref: value.causal.turn_ref,
			independence_known: value.causal.independence_known,
			source_ref: sourceRef(value.record),
			observed_at: value.record.created_at,
			created_at: input.now,
			expires_at: expiresAt,
			situation_redacted: value.pair.user,
			action_redacted: value.pair.assistant,
		};
		upserts.push({ id: `frontier-${sha256Hex(canonicalJson({ user_id: userId, lineage_ref: base.lineage_ref, turn_ref: base.turn_ref })).slice(0, 40)}`, ...base, frontier_checksum: frontierChecksum(base) });
	}
	const deleteRefMap = new Map<string, string>();
	for (const ref of [...invalidRefs, ...[...consumedFrontierRefs].map(([id, row_checksum]) => ({ id, row_checksum }))]) if (!deleteRefMap.has(ref.id)) deleteRefMap.set(ref.id, ref.row_checksum);
	const transitionBase = { user_id: userId, created_at: input.now, delete_refs: [...deleteRefMap].map(([id, row_checksum]) => ({ id, row_checksum })).sort((a, b) => a.id.localeCompare(b.id)), upserts: upserts.sort((a, b) => a.id.localeCompare(b.id)) };
	const transition: EpisodeFrontierTransition = { ...transitionBase, checksum: transitionChecksum(transitionBase) };
	const withoutChecksum = { schema_version: 1 as const, user_id: userId, file_generation: first.file_generation, seq_start: first.seq, seq_end: last.seq, units: [...outcomes.slice(0, MAX_SITUATION_EVIDENCE_UNITS / 2), ...explicit.slice(0, MAX_SITUATION_EVIDENCE_UNITS / 2)], transition };
	return { ...withoutChecksum, checksum: checksumJson({ schema: "agent_experience_situation_batch_v1", batch: JSON.parse(canonicalJson(withoutChecksum)) }) };
}

function refKey(ref: ProposalSourceRef): string {
	return `${ref.file_generation}:${ref.seq}:${ref.checksum}`;
}

export function validateSituationEvidenceForProposal(proposal: { source_refs: ProposalSourceRef[]; evidence_unit_refs?: string[]; evidence_basis?: SituationEvidenceBasis; exact_user_quote?: string }, batch: SituationBatch): SituationEvidenceUnit[] {
	if (!Array.isArray(proposal.evidence_unit_refs) || proposal.evidence_unit_refs.length < 1 || proposal.evidence_unit_refs.length > 20) throw new Error("Invalid evidence_unit_refs");
	if (new Set(proposal.evidence_unit_refs).size !== proposal.evidence_unit_refs.length) throw new Error("Duplicate evidence_unit_ref");
	const byId = new Map(batch.units.map((unit) => [unit.evidence_unit_ref, unit]));
	const units = proposal.evidence_unit_refs.map((id) => {
		const unit = byId.get(id);
		if (!unit) throw new Error("Evidence unit is unavailable");
		return unit;
	});
	const expectedRefs = new Set(units.flatMap((unit) => unit.current_source_refs).map(refKey));
	const actualRefs = new Set(proposal.source_refs.map(refKey));
	if (expectedRefs.size !== actualRefs.size || [...expectedRefs].some((key) => !actualRefs.has(key))) throw new Error("Evidence unit source refs mismatch");
	const basis = proposal.evidence_basis ?? "inferred_pattern";
	if (basis === "inferred_pattern") {
		if (units.some((unit) => unit.kind !== "linked_turn")) throw new Error("Inferred pattern requires assessed linked turns");
		if (proposal.exact_user_quote !== undefined) throw new Error("Inferred pattern cannot carry explicit quote");
	} else if (basis === "explicit_durable_preference") {
		if (units.length !== 1 || units[0].kind !== "explicit_user_statement") throw new Error("Explicit durable preference requires one exact user statement");
		if (typeof proposal.exact_user_quote !== "string" || proposal.exact_user_quote.length < 8 || proposal.exact_user_quote.length > FEEDBACK_CHARS || !units[0].user_statement_redacted?.includes(proposal.exact_user_quote)) throw new Error("Explicit durable preference quote mismatch");
	} else throw new Error("Invalid evidence_basis");
	return units;
}

export function persistedSituationEvidence(units: SituationEvidenceUnit[], basis: SituationEvidenceBasis): unknown[] {
	return units.map((unit) => ({
		unit_id: unit.evidence_unit_ref,
		kind: basis === "inferred_pattern" ? "assessed_user_feedback" : "explicit_user_statement",
		lineage_ref: unit.lineage_ref,
		independence_known: unit.independence_known,
		occurred_at: unit.occurred_at,
		current_source_refs: unit.current_source_refs,
		...(unit.historical_source_ref ? { historical_source_ref: unit.historical_source_ref } : {}),
	}));
}

export function situationEvidenceEligibility(existing: unknown, incoming: unknown[], basis: SituationEvidenceBasis): { reviewable: boolean; independent_lineages: number; distinct_days: number } {
	const existingData = existing && typeof existing === "object" && !Array.isArray(existing) ? existing as any : {};
	const prior = existingData.evidence_protocol === "situation_v2" && Array.isArray(existingData.evidence_units) ? existingData.evidence_units : [];
	const combined = new Map<string, any>();
	for (const unit of [...prior, ...incoming]) if (unit && typeof unit.unit_id === "string" && !combined.has(unit.unit_id)) combined.set(unit.unit_id, unit);
	if (basis === "explicit_durable_preference") return { reviewable: incoming.length === 1 && (incoming[0] as any)?.kind === "explicit_user_statement", independent_lineages: 0, distinct_days: 0 };
	const valid = [...combined.values()].filter((unit) => unit.kind === "assessed_user_feedback" && unit.independence_known === true && HASH.test(unit.lineage_ref));
	const lineages = new Set(valid.map((unit) => unit.lineage_ref));
	const days = new Set(valid.map((unit) => String(unit.occurred_at || "").slice(0, 10)).filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)));
	return { reviewable: lineages.size >= 3 && days.size >= 2, independent_lineages: lineages.size, distinct_days: days.size };
}

/** Caller owns the surrounding write transaction. */
export function applyEpisodeFrontierTransitionInTransaction(db: any, batch: SituationBatch): void {
	const { checksum, ...transition } = batch.transition;
	if (checksum !== transitionChecksum(transition)) throw new Error("Episode frontier transition checksum mismatch");
	for (const ref of transition.delete_refs) {
		const deleted = Number(db.prepare("DELETE FROM contexts WHERE user_id = ? AND record_kind = ? AND id = ? AND checksum = ?").run(transition.user_id, EPISODE_FRONTIER_KIND, ref.id, ref.row_checksum).changes || 0);
		if (!deleted) {
			const changed = db.prepare("SELECT 1 FROM contexts WHERE user_id = ? AND id = ?").get(transition.user_id, ref.id);
			if (changed) throw new Error("Episode frontier changed after snapshot");
		}
	}
	for (const frontier of transition.upserts) {
		const row = buildTypedStorageRow("contexts", { id: frontier.id, userId: transition.user_id, data: frontierData(frontier), now: transition.created_at });
		const existing = db.prepare("SELECT * FROM contexts WHERE user_id = ? AND id = ?").get(transition.user_id, frontier.id);
		if (existing) {
			const prior = parseFrontierRow(existing);
			if (!prior || prior.lineage_ref !== frontier.lineage_ref || prior.turn_ref !== frontier.turn_ref || prior.independence_known !== frontier.independence_known || refKey(prior.source_ref) !== refKey(frontier.source_ref) || prior.situation_redacted !== frontier.situation_redacted || prior.action_redacted !== frontier.action_redacted) throw new Error("Episode frontier stable id collision");
			continue;
		}
		db.prepare(`INSERT INTO contexts (id, user_id, record_kind, schema_version, status, habit_id, condition, behavior, polarity, confidence_bp, activation, staleness, data_json, checksum, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(row.id, row.user_id, row.record_kind, row.schema_version, row.status, row.habit_id, row.condition, row.behavior, row.polarity, row.confidence_bp, row.activation, row.staleness, row.data_json, row.checksum, row.created_at, row.updated_at);
	}
	const overflow = db.prepare(`SELECT id FROM contexts WHERE user_id = ? AND record_kind = ? ORDER BY updated_at DESC, id DESC LIMIT -1 OFFSET ?`).all(transition.user_id, EPISODE_FRONTIER_KIND, MAX_EPISODE_FRONTIERS_PER_USER);
	for (const row of overflow) db.prepare("DELETE FROM contexts WHERE user_id = ? AND record_kind = ? AND id = ?").run(transition.user_id, EPISODE_FRONTIER_KIND, row.id);
}

export function purgeAllEpisodeFrontiers(db: any, userId: string): number {
	return Number(db.prepare("DELETE FROM contexts WHERE user_id = ? AND record_kind = ?").run(normalizeUserId(userId), EPISODE_FRONTIER_KIND).changes || 0);
}

export function clampAndPurgeEpisodeFrontiers(db: any, input: { userId: string; retentionDays: number; now: string }): number {
	const userId = normalizeUserId(input.userId);
	const now = Date.parse(input.now);
	if (!Number.isFinite(now) || ![7, 14, 30].includes(Math.trunc(input.retentionDays))) throw new Error("Invalid frontier retention clamp");
	let changed = 0;
	const rows = db.prepare("SELECT * FROM contexts WHERE user_id = ? AND record_kind = ? ORDER BY id").all(userId, EPISODE_FRONTIER_KIND);
	for (const row of rows) {
		const frontier = parseFrontierRow(row);
		if (!frontier || Date.parse(frontier.expires_at) <= now) {
			changed += Number(db.prepare("DELETE FROM contexts WHERE user_id = ? AND id = ?").run(userId, row.id).changes || 0);
			continue;
		}
		const observed = Date.parse(frontier.observed_at);
		if (!Number.isFinite(observed)) {
			changed += Number(db.prepare("DELETE FROM contexts WHERE user_id = ? AND id = ?").run(userId, row.id).changes || 0);
			continue;
		}
		const clampedMs = Math.min(Date.parse(frontier.expires_at), observed + input.retentionDays * 86_400_000);
		if (clampedMs <= now) {
			changed += Number(db.prepare("DELETE FROM contexts WHERE user_id = ? AND id = ?").run(userId, row.id).changes || 0);
			continue;
		}
		const clamped = new Date(clampedMs).toISOString();
		if (clamped === frontier.expires_at) continue;
		const base = { lineage_ref: frontier.lineage_ref, turn_ref: frontier.turn_ref, independence_known: frontier.independence_known, source_ref: frontier.source_ref, observed_at: frontier.observed_at, created_at: frontier.created_at, expires_at: clamped, situation_redacted: frontier.situation_redacted, action_redacted: frontier.action_redacted };
		const next = { ...frontier, ...base, frontier_checksum: frontierChecksum(base) };
		const rebuilt = buildTypedStorageRow("contexts", { id: row.id, userId, data: frontierData(next), createdAt: row.created_at, updatedAt: input.now });
		changed += Number(db.prepare("UPDATE contexts SET data_json = ?, checksum = ?, updated_at = ? WHERE user_id = ? AND id = ? AND checksum = ?").run(rebuilt.data_json, rebuilt.checksum, rebuilt.updated_at, userId, row.id, row.checksum).changes || 0);
	}
	return changed;
}

export function situationUnitsForModel(batch: SituationBatch): unknown[] {
	return batch.units.map((unit) => redactJson({
		evidence_unit_ref: unit.evidence_unit_ref,
		kind: unit.kind,
		occurred_at: unit.occurred_at,
		independence_known: unit.independence_known,
		...(unit.situation_redacted ? { situation: unit.situation_redacted } : {}),
		...(unit.action_redacted ? { assistant_action: unit.action_redacted } : {}),
		...(unit.linked_user_turn_redacted ? { linked_user_turn: unit.linked_user_turn_redacted } : {}),
		...(unit.user_statement_redacted ? { exact_user_statement: unit.user_statement_redacted } : {}),
	}));
}
