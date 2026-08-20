import type { DatabaseSync } from "node:sqlite";
import { canonicalJson, checksumJson } from "../storage/checksum.ts";
import { normalizeUserId } from "../storage/private-root.ts";
import {
	buildExperienceCandidate,
	computeExperienceChecksum,
	experienceApprovalIdentity,
	isExperienceEligible,
	validateExperienceRecord,
} from "./schema.ts";
import type { ExperienceCandidateInput, ExperienceRecordV1, ExperienceScope, ExperienceStatus } from "./types.ts";

interface ExperienceRowData {
	exceptions: string[];
	provenance: ExperienceRecordV1["provenance"];
	approval?: {
		id: string;
		identity: string;
		reviewedChecksum: string;
		approvedAt: string;
		source: "review" | "migration";
	};
	migration?: Record<string, unknown>;
}

interface ExperienceRow {
	id: string;
	user_id: string;
	kind: string;
	schema_version: number;
	status: string;
	scope_kind: string;
	scope_key: string | null;
	authority: string;
	applicability: string;
	content: string;
	rationale: string | null;
	confidence_bp: number;
	valid_from: string;
	expires_at: string | null;
	last_confirmed_at: string;
	data_json: string;
	checksum: string;
	created_at: string;
	updated_at: string;
}

function parseRowData(row: ExperienceRow): ExperienceRowData {
	let parsed: unknown;
	try {
		parsed = JSON.parse(row.data_json);
	} catch {
		throw new Error(`Experience ${row.id} has invalid data_json`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Experience ${row.id} has invalid data_json`);
	}
	const data = parsed as Partial<ExperienceRowData>;
	if (!Array.isArray(data.exceptions) || !Array.isArray(data.provenance)) {
		throw new Error(`Experience ${row.id} is missing typed row data`);
	}
	return data as ExperienceRowData;
}

function relationsFor(db: DatabaseSync, userId: string, sourceId: string): Pick<ExperienceRecordV1, "supersedes" | "conflictsWith"> {
	const rows = db
		.prepare("SELECT relation, target_id FROM experience_relations WHERE user_id = ? AND source_id = ? ORDER BY relation, target_id")
		.all(userId, sourceId) as Array<{ relation: string; target_id: string }>;
	return {
		supersedes: rows.filter(row => row.relation === "supersedes").map(row => row.target_id),
		conflictsWith: rows.filter(row => row.relation === "conflicts_with").map(row => row.target_id),
	};
}

function recordFromRow(db: DatabaseSync, row: ExperienceRow): ExperienceRecordV1 {
	const data = parseRowData(row);
	const relations = relationsFor(db, row.user_id, row.id);
	const record = validateExperienceRecord({
		schemaVersion: row.schema_version,
		id: row.id,
		userId: row.user_id,
		kind: row.kind,
		scope: row.scope_key === null ? { kind: row.scope_kind } : { kind: row.scope_kind, key: row.scope_key },
		authority: row.authority,
		status: row.status,
		applicability: row.applicability,
		content: row.content,
		...(row.rationale === null ? {} : { rationale: row.rationale }),
		exceptions: data.exceptions,
		confidenceBp: row.confidence_bp,
		validFrom: row.valid_from,
		...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
		lastConfirmedAt: row.last_confirmed_at,
		...relations,
		provenance: data.provenance,
		checksum: row.checksum,
	});
	if (record.status === "active") {
		if (!data.approval || canonicalJson(data.approval.identity) !== canonicalJson(experienceApprovalIdentity(record))) {
			throw new Error(`Active experience ${record.id} has no matching approval identity`);
		}
	}
	return record;
}

function insertRow(db: DatabaseSync, record: ExperienceRecordV1, data: ExperienceRowData, now: string): void {
	db.prepare(`INSERT INTO experiences (
		id, user_id, kind, schema_version, status, scope_kind, scope_key, authority,
		applicability, content, rationale, confidence_bp, valid_from, expires_at,
		last_confirmed_at, data_json, checksum, created_at, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
		record.id,
		record.userId,
		record.kind,
		record.schemaVersion,
		record.status,
		record.scope.kind,
		record.scope.key ?? null,
		record.authority,
		record.applicability,
		record.content,
		record.rationale ?? null,
		record.confidenceBp,
		record.validFrom,
		record.expiresAt ?? null,
		record.lastConfirmedAt,
		canonicalJson(data),
		record.checksum,
		now,
		now,
	);
	const insertRelation = db.prepare(
		"INSERT INTO experience_relations (user_id, source_id, relation, target_id, created_at) VALUES (?, ?, ?, ?, ?)",
	);
	for (const targetId of record.supersedes) insertRelation.run(record.userId, record.id, "supersedes", targetId, now);
	for (const targetId of record.conflictsWith) insertRelation.run(record.userId, record.id, "conflicts_with", targetId, now);
}

function replaceRecord(db: DatabaseSync, record: ExperienceRecordV1, data: ExperienceRowData, now: string): void {
	db.prepare(`UPDATE experiences SET
		status = ?, scope_kind = ?, scope_key = ?, authority = ?, applicability = ?, content = ?,
		rationale = ?, confidence_bp = ?, valid_from = ?, expires_at = ?, last_confirmed_at = ?,
		data_json = ?, checksum = ?, updated_at = ?
		WHERE user_id = ? AND id = ?`).run(
		record.status,
		record.scope.kind,
		record.scope.key ?? null,
		record.authority,
		record.applicability,
		record.content,
		record.rationale ?? null,
		record.confidenceBp,
		record.validFrom,
		record.expiresAt ?? null,
		record.lastConfirmedAt,
		canonicalJson(data),
		record.checksum,
		now,
		record.userId,
		record.id,
	);
}

function auditMutation(
	db: DatabaseSync,
	input: { userId: string; id: string; action: string; before: ExperienceRecordV1; after: ExperienceRecordV1; now: string },
): void {
	const data = { approvalIdentity: experienceApprovalIdentity(input.after) };
	const audit = {
		id: `experience-audit:${input.action}:${input.id}:${input.now}`,
		user_id: input.userId,
		target_kind: "experience",
		target_id: input.id,
		action: input.action,
		before_json: canonicalJson(input.before),
		after_json: canonicalJson(input.after),
		data_json: canonicalJson(data),
		created_at: input.now,
	};
	const checksum = checksumJson(audit);
	db.prepare(`INSERT INTO experience_review_audit
		(id, user_id, target_kind, target_id, action, before_json, after_json, data_json, checksum, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
		audit.id,
		audit.user_id,
		audit.target_kind,
		audit.target_id,
		audit.action,
		audit.before_json,
		audit.after_json,
		audit.data_json,
		checksum,
		audit.created_at,
	);
}

export function getExperience(db: DatabaseSync, input: { userId: string; id: string }): ExperienceRecordV1 | undefined {
	const userId = normalizeUserId(input.userId);
	const row = db.prepare("SELECT * FROM experiences WHERE user_id = ? AND id = ?").get(userId, input.id) as ExperienceRow | undefined;
	return row ? recordFromRow(db, row) : undefined;
}

function mergeExperienceCandidateSupport(existing: ExperienceRecordV1, incoming: ExperienceRecordV1): ExperienceRecordV1 {
	if (experienceApprovalIdentity(existing) !== experienceApprovalIdentity(incoming)) {
		throw new Error(`Conflicting experience candidate id: ${incoming.id}`);
	}
	const provenance = [...existing.provenance];
	const seen = new Set(provenance.map(entry => `${entry.host}\0${entry.evidenceId}`));
	for (const entry of incoming.provenance) {
		const key = `${entry.host}\0${entry.evidenceId}`;
		if (seen.has(key) || provenance.length >= 64) continue;
		seen.add(key);
		provenance.push(entry);
	}
	const record = {
		...existing,
		confidenceBp: Math.max(existing.confidenceBp, incoming.confidenceBp),
		lastConfirmedAt: Date.parse(existing.lastConfirmedAt) >= Date.parse(incoming.lastConfirmedAt)
			? existing.lastConfirmedAt
			: incoming.lastConfirmedAt,
		provenance,
	};
	return validateExperienceRecord({ ...record, checksum: computeExperienceChecksum(record) });
}

export function insertExperienceCandidateInTransaction(
	db: DatabaseSync,
	input: ExperienceCandidateInput,
	options: { now?: string } = {},
): ExperienceRecordV1 {
	const now = options.now ?? new Date().toISOString();
	const record = buildExperienceCandidate({ ...input, userId: normalizeUserId(input.userId) });
	const existingRow = db.prepare("SELECT * FROM experiences WHERE user_id = ? AND id = ?").get(record.userId, record.id) as ExperienceRow | undefined;
	if (existingRow) {
		const existing = recordFromRow(db, existingRow);
		if (existing.checksum === record.checksum) return existing;
		const merged = mergeExperienceCandidateSupport(existing, record);
		replaceRecord(db, merged, { ...parseRowData(existingRow), exceptions: merged.exceptions, provenance: merged.provenance }, now);
		return merged;
	}
	insertRow(db, record, { exceptions: record.exceptions, provenance: record.provenance }, now);
	return record;
}

export function insertExperienceCandidate(
	db: DatabaseSync,
	input: ExperienceCandidateInput,
	options: { now?: string } = {},
): ExperienceRecordV1 {
	const now = options.now ?? new Date().toISOString();
	db.exec("BEGIN IMMEDIATE");
	try {
		const record = insertExperienceCandidateInTransaction(db, input, { now });
		db.exec("COMMIT");
		return record;
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {}
		throw error;
	}
}

export function activateExperience(
	db: DatabaseSync,
	input: { userId: string; id: string; reviewedChecksum: string; approvalId: string; now?: string },
): ExperienceRecordV1 {
	const userId = normalizeUserId(input.userId);
	const now = input.now ?? new Date().toISOString();
	db.exec("BEGIN IMMEDIATE");
	try {
		const before = getExperience(db, { userId, id: input.id });
		if (!before || before.status !== "candidate") throw new Error("Experience candidate is unavailable for approval");
		if (before.checksum !== input.reviewedChecksum) throw new Error("Experience candidate changed after review");
		if (before.conflictsWith.length > 0) {
			const placeholders = before.conflictsWith.map(() => "?").join(", ");
			const activeConflicts = Number(db.prepare(
				`SELECT COUNT(*) AS count FROM experiences WHERE user_id = ? AND id IN (${placeholders}) AND status = 'active'`,
			).get(userId, ...before.conflictsWith)?.count ?? 0);
			if (activeConflicts > 0) throw new Error("Experience conflicts require explicit review before activation");
		}
		const row = db.prepare("SELECT data_json FROM experiences WHERE user_id = ? AND id = ?").get(userId, input.id) as { data_json: string };
		const data = JSON.parse(row.data_json) as ExperienceRowData;
		const draft = { ...before, status: "active", lastConfirmedAt: now } as Omit<ExperienceRecordV1, "checksum">;
		const after = validateExperienceRecord({ ...draft, checksum: computeExperienceChecksum(draft) });
		data.approval = {
			id: input.approvalId,
			identity: experienceApprovalIdentity(after),
			reviewedChecksum: input.reviewedChecksum,
			approvedAt: now,
			source: "review",
		};
		replaceRecord(db, after, data, now);
		auditMutation(db, { userId, id: input.id, action: "activate", before, after, now });
		db.exec("COMMIT");
		return after;
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {}
		throw error;
	}
}

function setExperienceStatusInTransaction(
	db: DatabaseSync,
	input: { userId: string; id: string; status: "superseded" | "disabled"; now: string },
): ExperienceRecordV1 {
	const before = getExperience(db, { userId: input.userId, id: input.id });
	if (!before) throw new Error("Experience is unavailable");
	const row = db.prepare("SELECT data_json FROM experiences WHERE user_id = ? AND id = ?").get(input.userId, input.id) as { data_json: string };
	const data = JSON.parse(row.data_json) as ExperienceRowData;
	delete data.approval;
	const draft = { ...before, status: input.status } as Omit<ExperienceRecordV1, "checksum">;
	const after = validateExperienceRecord({ ...draft, checksum: computeExperienceChecksum(draft) });
	replaceRecord(db, after, data, input.now);
	auditMutation(db, { userId: input.userId, id: input.id, action: input.status, before, after, now: input.now });
	return after;
}

function setExperienceStatus(
	db: DatabaseSync,
	input: { userId: string; id: string; status: "superseded" | "disabled"; now?: string },
): ExperienceRecordV1 {
	const userId = normalizeUserId(input.userId);
	const now = input.now ?? new Date().toISOString();
	db.exec("BEGIN IMMEDIATE");
	try {
		const after = setExperienceStatusInTransaction(db, { userId, id: input.id, status: input.status, now });
		db.exec("COMMIT");
		return after;
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {}
		throw error;
	}
}

export function supersedeExperience(
	db: DatabaseSync,
	input: {
		userId: string;
		id: string;
		replacementId: string;
		reviewedChecksum?: string;
		approvalId?: string;
		now?: string;
	},
): ExperienceRecordV1 {
	const userId = normalizeUserId(input.userId);
	const now = input.now ?? new Date().toISOString();
	db.exec("BEGIN IMMEDIATE");
	try {
		const replacement = getExperience(db, { userId, id: input.replacementId });
		if (!replacement || (replacement.status !== "active" && replacement.status !== "candidate")) throw new Error("Superseding experience must be active or candidate");
		if (replacement.status === "candidate") {
			if (!input.reviewedChecksum || !input.approvalId) throw new Error("Candidate replacement requires explicit approval");
			if (replacement.checksum !== input.reviewedChecksum) throw new Error("Experience candidate changed after review");
			const remainingConflicts = replacement.conflictsWith.filter(id => id !== input.id);
			if (remainingConflicts.length > 0) {
				const placeholders = remainingConflicts.map(() => "?").join(", ");
				const activeConflicts = Number(db.prepare(
					`SELECT COUNT(*) AS count FROM experiences WHERE user_id = ? AND id IN (${placeholders}) AND status = 'active'`,
				).get(userId, ...remainingConflicts)?.count ?? 0);
				if (activeConflicts > 0) throw new Error("Experience conflicts require explicit review before activation");
			}
		}
		const after = setExperienceStatusInTransaction(db, { userId, id: input.id, status: "superseded", now });
		db.prepare(`INSERT OR IGNORE INTO experience_relations
			(user_id, source_id, relation, target_id, created_at) VALUES (?, ?, 'supersedes', ?, ?)`).run(
			userId,
			input.replacementId,
			input.id,
			now,
		);
		db.prepare("DELETE FROM experience_relations WHERE user_id = ? AND source_id = ? AND relation = 'conflicts_with' AND target_id = ?").run(
			userId,
			input.replacementId,
			input.id,
		);
		const replacementRow = db.prepare("SELECT data_json FROM experiences WHERE user_id = ? AND id = ?").get(userId, input.replacementId) as { data_json: string };
		const replacementData = JSON.parse(replacementRow.data_json) as ExperienceRowData;
		const replacementDraft = {
			...replacement,
			status: "active",
			lastConfirmedAt: replacement.status === "candidate" ? now : replacement.lastConfirmedAt,
			supersedes: [...new Set([...replacement.supersedes, input.id])].sort(),
			conflictsWith: replacement.conflictsWith.filter(id => id !== input.id),
		} as Omit<ExperienceRecordV1, "checksum">;
		const updatedReplacement = validateExperienceRecord({
			...replacementDraft,
			checksum: computeExperienceChecksum(replacementDraft),
		});
		if (replacement.status === "candidate") {
			replacementData.approval = {
				id: input.approvalId!,
				identity: experienceApprovalIdentity(updatedReplacement),
				reviewedChecksum: input.reviewedChecksum!,
				approvedAt: now,
				source: "review",
			};
		}
		replaceRecord(db, updatedReplacement, replacementData, now);
		auditMutation(db, {
			userId,
			id: input.replacementId,
			action: replacement.status === "candidate" ? "activate_superseding" : "add_supersedes",
			before: replacement,
			after: updatedReplacement,
			now,
		});
		db.exec("COMMIT");
		return after;
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {}
		throw error;
	}
}
export function keepExperienceSeparate(
	db: DatabaseSync,
	input: { userId: string; id: string; otherId: string; reviewedChecksum: string; now?: string },
): ExperienceRecordV1 {
	const userId = normalizeUserId(input.userId);
	const now = input.now ?? new Date().toISOString();
	db.exec("BEGIN IMMEDIATE");
	try {
		const before = getExperience(db, { userId, id: input.id });
		if (!before || before.status !== "candidate") throw new Error("Experience candidate is unavailable for review");
		if (before.checksum !== input.reviewedChecksum) throw new Error("Experience candidate changed after review");
		if (!before.conflictsWith.includes(input.otherId)) throw new Error("Experience conflict is unavailable for review");
		const row = db.prepare("SELECT data_json FROM experiences WHERE user_id = ? AND id = ?").get(userId, input.id) as { data_json: string };
		const data = JSON.parse(row.data_json) as ExperienceRowData;
		const draft = {
			...before,
			conflictsWith: before.conflictsWith.filter(id => id !== input.otherId),
		} as Omit<ExperienceRecordV1, "checksum">;
		const after = validateExperienceRecord({ ...draft, checksum: computeExperienceChecksum(draft) });
		db.prepare("DELETE FROM experience_relations WHERE user_id = ? AND source_id = ? AND relation = 'conflicts_with' AND target_id = ?").run(
			userId,
			input.id,
			input.otherId,
		);
		replaceRecord(db, after, data, now);
		auditMutation(db, { userId, id: input.id, action: "keep_separate", before, after, data: { otherId: input.otherId }, now });
		db.exec("COMMIT");
		return after;
	} catch (error) {
		try { db.exec("ROLLBACK"); } catch {}
		throw error;
	}
}


export function disableExperience(
	db: DatabaseSync,
	input: { userId: string; id: string; now?: string },
): ExperienceRecordV1 {
	return setExperienceStatus(db, { ...input, status: "disabled" });
}

export function listExperiences(
	db: DatabaseSync,
	input: { userId: string; statuses?: ExperienceStatus[]; kinds?: ExperienceRecordV1["kind"][] },
): ExperienceRecordV1[] {
	const userId = normalizeUserId(input.userId);
	const statuses = input.statuses ? new Set(input.statuses) : undefined;
	const kinds = input.kinds ? new Set(input.kinds) : undefined;
	const rows = db.prepare("SELECT * FROM experiences WHERE user_id = ? ORDER BY created_at, id").all(userId) as ExperienceRow[];
	const records: ExperienceRecordV1[] = [];
	for (const row of rows) {
		if (statuses && !statuses.has(row.status as ExperienceStatus)) continue;
		if (kinds && !kinds.has(row.kind as ExperienceRecordV1["kind"])) continue;
		try {
			records.push(recordFromRow(db, row));
		} catch {
			// Corrupt records fail closed without suppressing valid review items.
		}
	}
	return records;
}

export function listEligibleExperiences(
	db: DatabaseSync,
	input: { userId: string; now: string; scope?: ExperienceScope },
): ExperienceRecordV1[] {
	const userId = normalizeUserId(input.userId);
	const rows = db.prepare("SELECT * FROM experiences WHERE user_id = ? AND status = 'active' ORDER BY id").all(userId) as ExperienceRow[];
	const eligible: ExperienceRecordV1[] = [];
	for (const row of rows) {
		try {
			const record = recordFromRow(db, row);
			if (!isExperienceEligible(record, { userId, now: input.now })) continue;
			if (input.scope && (record.scope.kind !== input.scope.kind || record.scope.key !== input.scope.key)) continue;
			eligible.push(record);
		} catch {
			// Corrupt rows fail closed without suppressing valid records.
		}
	}
	return eligible;
}
