import { normalizeUserId } from "../storage/private-root.ts";
import { canonicalJson, checksumJson, sha256Hex } from "../storage/checksum.ts";
import { buildTypedStorageRow } from "../storage/sqlite.ts";
import type { ValidatedObservationRecord } from "./observations.ts";
import { observationKey } from "./observations.ts";
import { validateProposalBatch, type HabitCandidateProposal, type ValidatedProposalBatch } from "./proposals.ts";

export interface ConsolidationResult {
	user_id: string;
	file_generation: string;
	watermark_before: Watermark | null;
	watermark_after: Watermark;
	read_watermark_after?: Watermark;
	candidate_ids: string[];
	evidence_ids: string[];
	audit_id: string;
	inserted: { candidates: number; evidence: number; audit: number; watermark: 0 | 1; read_watermark?: 0 | 1 };
}

export interface Watermark {
	user_id: string;
	file_generation: string;
	seq: number;
	checksum: string;
	updated_at: string;
	row_checksum: string;
}

interface CommitInput {
	db: any;
	userId: string;
	proposalBatch: unknown;
	observations: ValidatedObservationRecord[];
	readCoverage?: { seq_start: number; last: ValidatedObservationRecord };
}

function stableId(prefix: string, value: unknown): string {
	return `${prefix}-${sha256Hex(canonicalJson(value)).slice(0, 40)}`;
}

function normalizeIdentityText(value: string): string {
	return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function habitIdentity(proposal: HabitCandidateProposal, userId: string): unknown {
	return {
		schema_version: 2,
		user_id: userId,
		record_kind: "candidate_habit_v1",
		condition: normalizeIdentityText(proposal.condition),
		behavior: normalizeIdentityText(proposal.behavior),
		polarity: proposal.polarity,
	};
}

function uniqueArrayByCanonical(values: unknown[]): unknown[] {
	const seen = new Set<string>();
	const out: unknown[] = [];
	for (const value of values) {
		const key = canonicalJson(value);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(value);
	}
	return out;
}

function mergeCandidateData(existingResidual: any, incoming: any): unknown {
	const merged: Record<string, unknown> = { ...(incoming && typeof incoming === "object" && !Array.isArray(incoming) ? incoming : {}) };
	for (const key of [
		"status",
		"review_status",
		"law_hash",
		"activation_decision",
		"promotion_decision",
		"law_rechecked_at",
		"law_suppression",
		"accepted_at",
		"promoted_at",
		"enabled_at",
		"active",
		"injectable",
	]) {
		if (existingResidual && Object.prototype.hasOwnProperty.call(existingResidual, key)) merged[key] = existingResidual[key];
	}
	merged.source_refs = uniqueArrayByCanonical([...(Array.isArray(existingResidual?.source_refs) ? existingResidual.source_refs : []), ...(Array.isArray((incoming as any)?.source_refs) ? (incoming as any).source_refs : [])]);
	merged.source_dates = uniqueArrayByCanonical([...(Array.isArray(existingResidual?.source_dates) ? existingResidual.source_dates : []), ...(Array.isArray((incoming as any)?.source_dates) ? (incoming as any).source_dates : [])]).sort();
	return merged;
}

function insertIdempotentStorageRecord(db: any, table: "habits" | "evidence", input: { id: string; userId: string; data: unknown; now: string }): { id: string; inserted: boolean; checksum: string } {
	const row = buildTypedStorageRow(table, { id: input.id, userId: input.userId, data: input.data, now: input.now });
	const existing = db.prepare(`SELECT id, user_id, record_kind, schema_version, status, habit_id, condition, behavior, polarity, confidence_bp, activation, staleness, data_json, checksum, created_at, updated_at FROM ${table} WHERE id = ?`).get(input.id);
	if (existing) {
		if (existing.user_id !== input.userId) throw new Error(`${table} stable id collision`);
		if (existing.checksum === row.checksum) return { id: input.id, inserted: false, checksum: row.checksum };
		if (table !== "habits") throw new Error(`${table} stable id collision`);
		const existingData = { ...JSON.parse(existing.data_json), record_kind: existing.record_kind, schema_version: existing.schema_version, status: existing.status, habit_id: existing.habit_id, condition: existing.condition, behavior: existing.behavior, polarity: existing.polarity, confidence_bp: existing.confidence_bp, activation: existing.activation, staleness: existing.staleness };
		const merged = buildTypedStorageRow(table, { id: input.id, userId: input.userId, data: mergeCandidateData(existingData, input.data), createdAt: existing.created_at, now: input.now });
		db.prepare(`UPDATE habits SET record_kind=?, schema_version=?, status=?, habit_id=?, condition=?, behavior=?, polarity=?, confidence_bp=?, activation=?, staleness=?, data_json = ?, checksum = ?, updated_at = ? WHERE id = ? AND user_id = ?`).run(merged.record_kind, merged.schema_version, merged.status, merged.habit_id, merged.condition, merged.behavior, merged.polarity, merged.confidence_bp, merged.activation, merged.staleness, merged.data_json, merged.checksum, merged.updated_at, merged.id, merged.user_id);
		return { id: input.id, inserted: false, checksum: merged.checksum };
	}
	db.prepare(`INSERT INTO ${table} (id, user_id, record_kind, schema_version, status, habit_id, condition, behavior, polarity, confidence_bp, activation, staleness, data_json, checksum, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
		row.id,
		row.user_id,
		row.record_kind,
		row.schema_version,
		row.status,
		row.habit_id,
		row.condition,
		row.behavior,
		row.polarity,
		row.confidence_bp,
		row.activation,
		row.staleness,
		row.data_json,
		row.checksum,
		row.created_at,
		row.updated_at,
	);
	return { id: input.id, inserted: true, checksum: row.checksum };
}

function watermarkChecksum(table: "consolidation_watermarks" | "proposal_read_watermarks", row: Omit<Watermark, "row_checksum">): string {
	return checksumJson({ table, row });
}

function getWatermarkFromTable(db: any, table: "consolidation_watermarks" | "proposal_read_watermarks", userId: string, fileGeneration: string): Watermark | null {
	const row = db.prepare(`SELECT user_id, file_generation, seq, checksum, updated_at, row_checksum FROM ${table} WHERE user_id = ? AND file_generation = ?`).get(userId, fileGeneration);
	if (!row) return null;
	const candidate = { user_id: row.user_id, file_generation: row.file_generation, seq: row.seq, checksum: row.checksum, updated_at: row.updated_at };
	if (row.row_checksum !== watermarkChecksum(table, candidate)) throw new Error(`Invalid ${table} checksum`);
	return { ...candidate, row_checksum: row.row_checksum };
}

function getWatermark(db: any, userId: string, fileGeneration: string): Watermark | null {
	return getWatermarkFromTable(db, "consolidation_watermarks", userId, fileGeneration);
}

function upsertWatermarkTable(db: any, table: "consolidation_watermarks" | "proposal_read_watermarks", row: Omit<Watermark, "row_checksum">): { row: Watermark; changed: 0 | 1 } {
	const full: Watermark = { ...row, row_checksum: watermarkChecksum(table, row) };
	const existing = getWatermarkFromTable(db, table, row.user_id, row.file_generation);
	if (existing) {
		if (row.seq < existing.seq) throw new Error("Watermark would move backward");
		if (row.seq === existing.seq && row.checksum !== existing.checksum) throw new Error("Watermark checksum collision");
		if (row.seq === existing.seq && row.checksum === existing.checksum) return { row: existing, changed: 0 };
	}
	db.prepare(`INSERT INTO ${table} (user_id, file_generation, seq, checksum, updated_at, row_checksum)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, file_generation) DO UPDATE SET seq=excluded.seq, checksum=excluded.checksum, updated_at=excluded.updated_at, row_checksum=excluded.row_checksum`)
		.run(full.user_id, full.file_generation, full.seq, full.checksum, full.updated_at, full.row_checksum);
	return { row: full, changed: 1 };
}

function upsertWatermark(db: any, row: Omit<Watermark, "row_checksum">): { row: Watermark; changed: 0 | 1 } {
	return upsertWatermarkTable(db, "consolidation_watermarks", row);
}

function upsertProposalReadWatermark(db: any, input: { userId: string; fileGeneration: string; seqStart: number; seqEnd: number; checksum: string; updatedAt: string }): { row: Watermark; changed: 0 | 1 } {
	if (!Number.isInteger(input.seqStart) || !Number.isInteger(input.seqEnd) || input.seqStart < 1 || input.seqEnd < input.seqStart) throw new Error("Invalid proposal read coverage range");
	const existing = getWatermarkFromTable(db, "proposal_read_watermarks", input.userId, input.fileGeneration);
	if (!existing && input.seqStart !== 1) throw new Error("Proposal read coverage must start at seq 1");
	if (existing) {
		if (input.seqStart > existing.seq + 1) throw new Error("Proposal read coverage would skip observations");
		if (input.seqEnd < existing.seq) return { row: existing, changed: 0 };
		if (input.seqEnd === existing.seq && input.checksum !== existing.checksum) throw new Error("Proposal read watermark checksum collision");
	}
	return upsertWatermarkTable(db, "proposal_read_watermarks", { user_id: input.userId, file_generation: input.fileGeneration, seq: input.seqEnd, checksum: input.checksum, updated_at: input.updatedAt });
}

function insertAudit(db: any, input: { userId: string; fileGeneration: string; batch: ValidatedProposalBatch; action: string; candidateIds: string[]; evidenceIds: string[]; watermarkBefore: Watermark | null; watermarkAfter: Watermark }): { id: string; inserted: boolean } {
	const data = {
		run_id: stableId("run", { batch_checksum: input.batch.checksum, action: input.action }),
		proposal_batch_checksum: input.batch.checksum,
		action: input.action,
		candidate_ids: input.candidateIds,
		evidence_ids: input.evidenceIds,
		watermark_before: input.watermarkBefore ? { file_generation: input.watermarkBefore.file_generation, seq: input.watermarkBefore.seq, checksum: input.watermarkBefore.checksum } : null,
		watermark_after: { file_generation: input.watermarkAfter.file_generation, seq: input.watermarkAfter.seq, checksum: input.watermarkAfter.checksum },
	};
	const dataJson = canonicalJson(data);
	const checksum = checksumJson({ table: "consolidation_audit", user_id: input.userId, data });
	const id = stableId("audit", { user_id: input.userId, file_generation: input.fileGeneration, batch_checksum: input.batch.checksum, action: input.action });
	const existing = db.prepare("SELECT id, user_id, data_json, checksum FROM consolidation_audit WHERE id = ?").get(id);
	if (existing) {
		const existingData = JSON.parse(existing.data_json);
		const sameResult = existing.user_id === input.userId
			&& existingData.proposal_batch_checksum === data.proposal_batch_checksum
			&& existingData.action === data.action
			&& canonicalJson(existingData.candidate_ids) === canonicalJson(data.candidate_ids)
			&& canonicalJson(existingData.evidence_ids) === canonicalJson(data.evidence_ids)
			&& canonicalJson(existingData.watermark_after) === canonicalJson(data.watermark_after);
		if (!sameResult) throw new Error("Audit stable id collision");
		return { id, inserted: false };
	}
	db.prepare("INSERT INTO consolidation_audit (id, user_id, file_generation, proposal_batch_checksum, action, data_json, checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
		.run(id, input.userId, input.fileGeneration, input.batch.checksum, input.action, dataJson, checksum, input.batch.created_at);
	return { id, inserted: true };
}

function requireSingleGeneration(batch: ValidatedProposalBatch): string {
	const generations = new Set(batch.proposals.flatMap((proposal) => proposal.source_refs.map((ref) => ref.file_generation)));
	if (generations.size !== 1) throw new Error("Proposal batch spans multiple generations");
	const [generation] = [...generations];
	if (!generation) throw new Error("Proposal batch missing generation");
	return generation;
}

function buildObservationMap(observations: ValidatedObservationRecord[], userId: string, fileGeneration: string): Map<string, ValidatedObservationRecord> {
	const map = new Map<string, ValidatedObservationRecord>();
	for (const record of observations) {
		if (record.user_id !== userId || record.file_generation !== fileGeneration) throw new Error("Observation set mismatch");
		map.set(observationKey(record), record);
	}
	return map;
}

function validateSourceRefs(proposal: HabitCandidateProposal, observationMap: Map<string, ValidatedObservationRecord>): ValidatedObservationRecord[] {
	return proposal.source_refs.map((ref) => {
		const observation = observationMap.get(observationKey(ref));
		if (!observation) throw new Error("Proposal source observation not found");
		if (observation.checksum !== ref.checksum) throw new Error("Proposal source checksum mismatch");
		return observation;
	});
}

function proposalCandidateData(batch: ValidatedProposalBatch, proposal: HabitCandidateProposal, sourceDates: string[]) {
	return {
		schema_version: 2,
		record_kind: "candidate_habit_v1",
		status: "candidate",
		active: false,
		injectable: false,
		source_kind: "phase4a_fixture",
		batch_id: batch.batch_id,
		proposal_id: proposal.proposal_id,
		candidate_key: proposal.candidate_key,
		condition: proposal.condition,
		behavior: proposal.behavior,
		polarity: proposal.polarity,
		confidence_bp: proposal.confidence_bp,
		source_refs: proposal.source_refs,
		source_dates: sourceDates,
	};
}

function proposalEvidenceData(_batch: ValidatedProposalBatch, proposal: HabitCandidateProposal, sourceDates: string[], habitId: string) {
	return {
		schema_version: 2,
		record_kind: "candidate_evidence_v1",
		status: "candidate",
		habit_id: habitId,
		active: false,
		injectable: false,
		source_kind: "phase4_model_or_fixture",
		polarity: proposal.polarity,
		confidence_bp: proposal.confidence_bp,
		source_refs: proposal.source_refs,
		source_dates: sourceDates,
		...(proposal.evidence_summary === undefined ? {} : { evidence_summary: proposal.evidence_summary }),
	};
}

export function consolidateProposalBatch(input: CommitInput): ConsolidationResult {
	const userId = normalizeUserId(input.userId);
	const batch = validateProposalBatch(input.proposalBatch, userId);
	const fileGeneration = requireSingleGeneration(batch);
	const observationMap = buildObservationMap(input.observations, userId, fileGeneration);
	const sourceRecordsByProposal = batch.proposals.map((proposal) => validateSourceRefs(proposal, observationMap));
	const allRefs = batch.proposals.flatMap((proposal) => proposal.source_refs);
	const maxRef = allRefs.reduce((max, ref) => (ref.seq > max.seq ? ref : max), allRefs[0]);
	if (!maxRef) throw new Error("Proposal batch missing source refs");
	let result: ConsolidationResult | undefined;
	input.db.exec("BEGIN IMMEDIATE");
	try {
		const watermarkBefore = getWatermark(input.db, userId, fileGeneration);
		const candidateIds: string[] = [];
		const evidenceIds: string[] = [];
		let insertedCandidates = 0;
		let insertedEvidence = 0;
		for (let i = 0; i < batch.proposals.length; i++) {
			const proposal = batch.proposals[i];
			const sourceDates = sourceRecordsByProposal[i].map((record) => record.created_at);
			const candidateData = proposalCandidateData(batch, proposal, sourceDates);
			const candidateId = stableId("candidate", habitIdentity(proposal, userId));
			const evidenceData = proposalEvidenceData(batch, proposal, sourceDates, candidateId);
			const evidenceId = stableId("evidence", { schema_version: 2, user_id: userId, payload: evidenceData });
			const candidate = insertIdempotentStorageRecord(input.db, "habits", { id: candidateId, userId, data: candidateData, now: batch.created_at });
			const evidence = insertIdempotentStorageRecord(input.db, "evidence", { id: evidenceId, userId, data: evidenceData, now: batch.created_at });
			candidateIds.push(candidate.id);
			evidenceIds.push(evidence.id);
			if (candidate.inserted) insertedCandidates++;
			if (evidence.inserted) insertedEvidence++;
		}
		const watermark = upsertWatermark(input.db, { user_id: userId, file_generation: fileGeneration, seq: maxRef.seq, checksum: maxRef.checksum, updated_at: batch.created_at });
		let readWatermark: { row: Watermark; changed: 0 | 1 } | undefined;
		if (input.readCoverage) {
			if (input.readCoverage.last.user_id !== userId || input.readCoverage.last.file_generation !== fileGeneration) throw new Error("Proposal read coverage observation mismatch");
			if (input.readCoverage.last.seq < maxRef.seq) throw new Error("Proposal read coverage behind committed proposal refs");
			readWatermark = upsertProposalReadWatermark(input.db, { userId, fileGeneration, seqStart: input.readCoverage.seq_start, seqEnd: input.readCoverage.last.seq, checksum: input.readCoverage.last.checksum, updatedAt: batch.created_at });
		}
		const audit = insertAudit(input.db, { userId, fileGeneration, batch, action: "committed", candidateIds, evidenceIds, watermarkBefore, watermarkAfter: watermark.row });
		result = {
			user_id: userId,
			file_generation: fileGeneration,
			watermark_before: watermarkBefore,
			watermark_after: watermark.row,
			...(readWatermark ? { read_watermark_after: readWatermark.row } : {}),
			candidate_ids: candidateIds,
			evidence_ids: evidenceIds,
			audit_id: audit.id,
			inserted: { candidates: insertedCandidates, evidence: insertedEvidence, audit: audit.inserted ? 1 : 0, watermark: watermark.changed, ...(readWatermark ? { read_watermark: readWatermark.changed } : {}) },
		};
		input.db.exec("COMMIT");
	} catch (error) {
		try {
			input.db.exec("ROLLBACK");
		} catch {}
		throw error;
	}
	return result;
}

export function recordZeroProposalReadCoverage(input: { db: any; userId: string; fileGeneration: string; seqStart: number; last: ValidatedObservationRecord; createdAt: string }): { watermark_after: Watermark; inserted: { read_watermark: 0 | 1 } } {
	const userId = normalizeUserId(input.userId);
	if (input.last.user_id !== userId || input.last.file_generation !== input.fileGeneration) throw new Error("Proposal read coverage observation mismatch");
	let result: { watermark_after: Watermark; inserted: { read_watermark: 0 | 1 } } | undefined;
	input.db.exec("BEGIN IMMEDIATE");
	try {
		const watermark = upsertProposalReadWatermark(input.db, { userId, fileGeneration: input.fileGeneration, seqStart: input.seqStart, seqEnd: input.last.seq, checksum: input.last.checksum, updatedAt: input.createdAt });
		result = { watermark_after: watermark.row, inserted: { read_watermark: watermark.changed } };
		input.db.exec("COMMIT");
	} catch (error) {
		try {
			input.db.exec("ROLLBACK");
		} catch {}
		throw error;
	}
	return result;
}

export const stableConsolidationIdForTest = stableId;
