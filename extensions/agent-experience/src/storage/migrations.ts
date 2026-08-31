import { computeExperienceChecksum, experienceApprovalIdentity, validateExperienceRecord } from "../experience/schema.ts";
import type { ExperienceRecordV1 } from "../experience/types.ts";
import { normalizeSemanticText } from "../semantic/core.ts";
import { canonicalJson, checksumJson } from "./checksum.ts";
import { redactJson } from "./redaction.ts";
import { STORAGE_SCHEMA_SQL, STORAGE_SCHEMA_VERSION, STORAGE_STATUS_VALUES, STORAGE_TYPED_FIELDS } from "./schema.ts";

const USER_TABLES = ["habits", "evidence", "contexts"] as const;
const STATUS_SET = new Set<string>(STORAGE_STATUS_VALUES);
const TYPED_FIELD_SET = new Set<string>(STORAGE_TYPED_FIELDS as readonly string[]);

function typedTableSql(table: string): string {
	return `CREATE TABLE ${table} (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'owner',
  record_kind TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('candidate','active','dormant','archived','suppressed_by_law','disabled')),
  habit_id TEXT,
  condition TEXT,
  behavior TEXT,
  polarity INTEGER NOT NULL DEFAULT 0 CHECK(polarity IN (-1,0,1)),
  confidence_bp INTEGER NOT NULL DEFAULT 0 CHECK(confidence_bp BETWEEN 0 AND 10000),
  activation REAL NOT NULL DEFAULT 0,
  staleness REAL NOT NULL DEFAULT 0,
  data_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;
}

function tableExists(db: any, table: string): boolean {
	return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
}

function tableColumns(db: any, table: string): Set<string> {
	return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row: any) => String(row.name)));
}

function stringOrNull(value: unknown, max = 2000): string | null {
	if (value === undefined || value === null) return null;
	const text = String(value);
	if (text.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error("Invalid migrated typed string");
	return text;
}

function safeRecordKind(value: unknown): string {
	const text = stringOrNull(value, 160) || "legacy_record_v1";
	if (!/^[A-Za-z0-9._:-]+$/.test(text)) throw new Error("Invalid migrated record_kind");
	return text;
}

function safeSchemaVersion(value: unknown): number {
	const version = value === undefined || value === null ? 1 : Number(value);
	if (!Number.isInteger(version) || version < 1 || version > 1000) throw new Error("Invalid migrated schema_version");
	return version;
}

function safeStatus(value: unknown): string {
	const status = String(value ?? "candidate");
	if (!STATUS_SET.has(status)) throw new Error("Invalid migrated status");
	return status;
}

function safePolarity(value: unknown): -1 | 0 | 1 {
	const polarity = value === undefined || value === null ? 0 : Number(value);
	if (polarity !== -1 && polarity !== 0 && polarity !== 1) throw new Error("Invalid migrated polarity");
	return polarity;
}

function safeConfidenceBp(value: unknown): number {
	let confidence = value === undefined || value === null ? 0 : Number(value);
	if (Number.isFinite(confidence) && confidence > 0 && confidence <= 1) confidence = Math.round(confidence * 10000);
	if (!Number.isInteger(confidence) || confidence < 0 || confidence > 10000) throw new Error("Invalid migrated confidence_bp");
	return confidence;
}

function safeFiniteNumber(value: unknown, label: string): number {
	const number = value === undefined || value === null ? 0 : Number(value);
	if (!Number.isFinite(number)) throw new Error(`Invalid migrated ${label}`);
	return number;
}

function storageChecksum(table: string, row: any): string {
	return checksumJson({
		table,
		id: row.id,
		user_id: row.user_id,
		record_kind: row.record_kind,
		schema_version: row.schema_version,
		status: row.status,
		habit_id: row.habit_id,
		condition: row.condition,
		behavior: row.behavior,
		polarity: row.polarity,
		confidence_bp: row.confidence_bp,
		activation: row.activation,
		staleness: row.staleness,
		data: JSON.parse(row.data_json),
	});
}

function parseOldData(row: any): Record<string, unknown> {
	try {
		const parsed = JSON.parse(String(row.data_json || "{}"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
		return redactJson(parsed) as Record<string, unknown>;
	} catch (error: any) {
		throw new Error(`Invalid legacy data_json during migration: ${error?.message || error}`);
	}
}

function residualForNewRows(data: Record<string, unknown>): Record<string, unknown> {
	const residual: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) {
		if (TYPED_FIELD_SET.has(key)) continue;
		residual[key] = value;
	}
	return residual;
}

function migrateUserTable(db: any, table: typeof USER_TABLES[number], now: string): void {
	if (!tableExists(db, table)) return;
	const columns = tableColumns(db, table);
	if (columns.has("record_kind")) return;
	const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
	const tmp = `${table}__v3_migration`;
	db.exec(`DROP TABLE IF EXISTS ${tmp}`);
	db.exec(typedTableSql(tmp));
	const insert = db.prepare(`INSERT INTO ${tmp} (id, user_id, record_kind, schema_version, status, habit_id, condition, behavior, polarity, confidence_bp, activation, staleness, data_json, checksum, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	for (const oldRow of rows) {
		const oldData = parseOldData(oldRow);
		const createdAt = String(oldRow.created_at || now);
		const updatedAt = String(oldRow.updated_at || createdAt);
		const row: any = {
			id: String(oldRow.id),
			user_id: String(oldRow.user_id || "owner"),
			record_kind: safeRecordKind(oldData.record_kind),
			schema_version: safeSchemaVersion(oldData.schema_version),
			status: safeStatus(oldData.status),
			habit_id: stringOrNull(oldData.habit_id ?? oldData.candidate_id ?? null, 200),
			condition: stringOrNull(oldData.condition, 2000),
			behavior: stringOrNull(oldData.behavior, 2000),
			polarity: safePolarity(oldData.polarity),
			confidence_bp: safeConfidenceBp(oldData.confidence_bp ?? oldData.confidence),
			activation: safeFiniteNumber(oldData.activation, "activation"),
			staleness: safeFiniteNumber(oldData.staleness, "staleness"),
			data_json: canonicalJson(oldData.record_kind ? residualForNewRows(oldData) : oldData),
			created_at: createdAt,
			updated_at: updatedAt,
		};
		row.checksum = storageChecksum(table, row);
		insert.run(row.id, row.user_id, row.record_kind, row.schema_version, row.status, row.habit_id, row.condition, row.behavior, row.polarity, row.confidence_bp, row.activation, row.staleness, row.data_json, row.checksum, row.created_at, row.updated_at);
	}
	db.exec(`DROP TABLE ${table}`);
	db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
}

function quarantineHabitMigration(db: any, row: any, reason: string, now: string): void {
	const payload = {
		legacyHabitId: String(row.id),
		legacyChecksum: String(row.checksum ?? ""),
		reason,
	};
	const checksum = checksumJson(payload);
	db.prepare(`INSERT OR IGNORE INTO pending_review
		(id, user_id, kind, status, payload_json, checksum, created_at, updated_at)
		VALUES (?, ?, 'legacy_experience_migration', 'open', ?, ?, ?, ?)`).run(
		`legacy-experience-migration:${row.user_id}:${row.id}`,
		row.user_id,
		canonicalJson(payload),
		checksum,
		now,
		now,
	);
}

function migrateApprovedHabitsToExperiences(db: any, now: string): void {
	if (!tableExists(db, "habits")) return;
	const rows = db.prepare("SELECT * FROM habits ORDER BY user_id, id").all() as any[];
	const insert = db.prepare(`INSERT INTO experiences (
		id, user_id, kind, schema_version, status, scope_kind, scope_key, authority,
		applicability, content, rationale, confidence_bp, valid_from, expires_at,
		last_confirmed_at, data_json, checksum, created_at, updated_at
	) VALUES (?, ?, ?, 1, ?, 'user', NULL, 'reviewed_inference', ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?)`);
	for (const row of rows) {
		try {
			if (row.checksum !== storageChecksum("habits", row)) {
				quarantineHabitMigration(db, row, "legacy_checksum_mismatch", now);
				continue;
			}
			const legacyData = parseOldData(row);
			const status = row.status === "active" ? "active" : row.status === "candidate" ? "candidate" : "disabled";
			const createdAt = String(row.created_at || now);
			const updatedAt = String(row.updated_at || createdAt);
			const draft: Omit<ExperienceRecordV1, "checksum"> = {
				schemaVersion: 1,
				id: String(row.id),
				userId: String(row.user_id),
				kind: "habit",
				scope: { kind: "user" },
				authority: "reviewed_inference",
				status,
				applicability: String(row.condition || ""),
				content: String(row.behavior || ""),
				exceptions: [],
				confidenceBp: Number(row.confidence_bp),
				validFrom: createdAt,
				lastConfirmedAt: updatedAt,
				supersedes: [],
				conflictsWith: [],
				provenance: [{
					source: "migration",
					host: "migration",
					evidenceId: `legacy-habit:${row.id}:${row.checksum}`,
					observedAt: updatedAt,
				}],
			};
			const record = validateExperienceRecord({ ...draft, checksum: computeExperienceChecksum(draft) });
			const legacyApprovalIdentity = legacyData.approved_identity;
			const approvalMatches = !!legacyApprovalIdentity
				&& typeof legacyApprovalIdentity === "object"
				&& !Array.isArray(legacyApprovalIdentity)
				&& "candidate_id" in legacyApprovalIdentity
				&& legacyApprovalIdentity.candidate_id === record.id
				&& "condition" in legacyApprovalIdentity
				&& legacyApprovalIdentity.condition === normalizeSemanticText(record.applicability)
				&& "behavior" in legacyApprovalIdentity
				&& legacyApprovalIdentity.behavior === normalizeSemanticText(record.content)
				&& "polarity" in legacyApprovalIdentity
				&& Number(legacyApprovalIdentity.polarity) === Number(row.polarity);
			if (status === "active" && !approvalMatches) {
				quarantineHabitMigration(db, row, "legacy_approval_identity_mismatch", now);
				continue;
			}
			const data: Record<string, unknown> = {
				exceptions: record.exceptions,
				provenance: record.provenance,
				migration: {
					legacyTable: "habits",
					legacyChecksum: row.checksum,
					...(approvalMatches ? { legacyApprovalIdentity } : {}),
				},
			};
			if (status === "active") {
				data.approval = {
					id: `migration:${row.id}`,
					identity: experienceApprovalIdentity(record),
					reviewedChecksum: row.checksum,
					approvedAt: updatedAt,
					source: "migration",
				};
			}
			const existing = db.prepare("SELECT checksum FROM experiences WHERE user_id = ? AND id = ?").get(record.userId, record.id) as { checksum: string } | undefined;
			if (existing) {
				if (existing.checksum !== record.checksum) throw new Error(`Conflicting migrated experience: ${record.id}`);
				continue;
			}
			insert.run(
				record.id,
				record.userId,
				record.kind,
				record.status,
				record.applicability,
				record.content,
				record.confidenceBp,
				record.validFrom,
				record.lastConfirmedAt,
				canonicalJson(data),
				record.checksum,
				createdAt,
				updatedAt,
			);
		} catch (error: any) {
			quarantineHabitMigration(db, row, `legacy_migration_invalid:${String(error?.message || error).slice(0, 200)}`, now);
		}
	}
}

function validApprovedHabitSnapshot(row: any, snapshot: any, approval: any): boolean {
	if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
	if (String(snapshot.id || "") !== String(row.id) || String(snapshot.user_id || "") !== String(row.user_id)) return false;
	if (typeof snapshot.condition !== "string" || !snapshot.condition.trim() || typeof snapshot.behavior !== "string" || !snapshot.behavior.trim()) return false;
	if (snapshot.checksum !== storageChecksum("habits", snapshot)) return false;
	return approval.candidate_id === row.id
		&& approval.condition === normalizeSemanticText(snapshot.condition)
		&& approval.behavior === normalizeSemanticText(snapshot.behavior)
		&& Number(approval.polarity) === Number(snapshot.polarity);
}

function validHabitAudit(row: any, audit: any): boolean {
	const base = {
		user_id: row.user_id,
		target_kind: "habit",
		target_id: row.id,
		action: audit.action,
		before_json: audit.before_json,
		after_json: audit.after_json,
		data_json: audit.data_json,
		created_at: audit.created_at,
	};
	return checksumJson({ table: "experience_review_audit", row: base }) === audit.checksum;
}

function quarantineDamagedHabitRecovery(db: any, row: any, reason: string, now: string): void {
	const payload = { habitId: String(row.id), priorChecksum: String(row.checksum ?? ""), reason };
	const checksum = checksumJson(payload);
	db.prepare(`INSERT OR IGNORE INTO pending_review
		(id, user_id, kind, status, payload_json, checksum, created_at, updated_at)
		VALUES (?, ?, 'damaged_habit_recovery', 'open', ?, ?, ?, ?)`).run(
		`damaged-habit-recovery:${row.user_id}:${row.id}`,
		row.user_id,
		canonicalJson(payload),
		checksum,
		now,
		now,
	);
}

function recoverDamagedApprovedHabits(db: any, now: string): void {
	if (!tableExists(db, "habits") || !tableExists(db, "experience_review_audit")) return;
	const rows = db.prepare("SELECT * FROM habits WHERE condition IS NULL OR behavior IS NULL ORDER BY user_id, id").all() as any[];
	for (const row of rows) {
		try {
			const data = parseOldData(row);
			const requiresRecovery = data.approved_identity !== undefined
				|| data.approval_invalidated !== undefined
				|| data.review_status === "candidate_reapproval_required";
			if (!requiresRecovery) continue;
			if (row.checksum !== storageChecksum("habits", row)) {
				quarantineDamagedHabitRecovery(db, row, "damaged_habit_checksum_mismatch", now);
				continue;
			}
			const audits = db.prepare("SELECT action, before_json, after_json, data_json, checksum, created_at FROM experience_review_audit WHERE user_id = ? AND target_kind = 'habit' AND target_id = ? ORDER BY created_at DESC, id DESC").all(row.user_id, row.id) as any[];
			const validAudits = audits.filter((audit) => validHabitAudit(row, audit));
			let approval = data.approved_identity;
			if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
				for (const audit of validAudits) {
					if (audit.action !== "promotion_requires_reapproval") continue;
					try {
						const auditData = JSON.parse(String(audit.data_json || "{}"));
						if (auditData?.approved_identity && typeof auditData.approved_identity === "object" && !Array.isArray(auditData.approved_identity)) {
							approval = auditData.approved_identity;
							break;
						}
					} catch {}
				}
			}
			if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
				quarantineDamagedHabitRecovery(db, row, "damaged_habit_missing_approved_identity", now);
				continue;
			}
			let snapshot: any;
			for (const audit of validAudits) {
				for (const encoded of [audit.before_json, audit.after_json]) {
					try {
						const candidate = JSON.parse(String(encoded || ""));
						if (validApprovedHabitSnapshot(row, candidate, approval)) {
							snapshot = candidate;
							break;
						}
					} catch {}
				}
				if (snapshot) break;
			}
			if (!snapshot) {
				quarantineDamagedHabitRecovery(db, row, "damaged_habit_wording_not_recoverable", now);
				continue;
			}
			const repaired = {
				...row,
				record_kind: safeRecordKind(snapshot.record_kind),
				schema_version: safeSchemaVersion(snapshot.schema_version),
				habit_id: stringOrNull(snapshot.habit_id, 200),
				condition: stringOrNull(snapshot.condition, 2000),
				behavior: stringOrNull(snapshot.behavior, 2000),
				polarity: safePolarity(snapshot.polarity),
				confidence_bp: safeConfidenceBp(snapshot.confidence_bp),
				activation: safeFiniteNumber(snapshot.activation, "activation"),
				staleness: safeFiniteNumber(snapshot.staleness, "staleness"),
				updated_at: now,
			};
			repaired.checksum = storageChecksum("habits", repaired);
			const changed = db.prepare("UPDATE habits SET record_kind=?, schema_version=?, habit_id=?, condition=?, behavior=?, polarity=?, confidence_bp=?, activation=?, staleness=?, checksum=?, updated_at=? WHERE user_id=? AND id=? AND checksum=?")
				.run(repaired.record_kind, repaired.schema_version, repaired.habit_id, repaired.condition, repaired.behavior, repaired.polarity, repaired.confidence_bp, repaired.activation, repaired.staleness, repaired.checksum, repaired.updated_at, row.user_id, row.id, row.checksum).changes;
			if (changed !== 1) throw new Error("Damaged habit recovery raced");
			const beforeJson = canonicalJson(row);
			const afterJson = canonicalJson(repaired);
			const dataJson = canonicalJson({ reason: "restore_typed_fields_from_verified_audit_snapshot", prior_checksum: row.checksum });
			const auditBase = { user_id: row.user_id, target_kind: "habit", target_id: row.id, action: "repair_damaged_habit_typed_fields", before_json: beforeJson, after_json: afterJson, data_json: dataJson, created_at: now };
			const auditChecksum = checksumJson({ table: "experience_review_audit", row: auditBase });
			const auditId = `habit-storage-repair:${row.user_id}:${row.id}:${auditChecksum.slice(0, 16)}`;
			db.prepare("INSERT INTO experience_review_audit (id, user_id, target_kind, target_id, action, before_json, after_json, data_json, checksum, created_at) VALUES (?, ?, 'habit', ?, 'repair_damaged_habit_typed_fields', ?, ?, ?, ?, ?)")
				.run(auditId, row.user_id, row.id, beforeJson, afterJson, dataJson, auditChecksum, now);
		} catch (error: any) {
			quarantineDamagedHabitRecovery(db, row, `damaged_habit_recovery_failed:${String(error?.message || error).slice(0, 200)}`, now);
		}
	}
}


export function readStorageSchemaVersion(db: any): number {
	const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
	if (!Number.isInteger(version) || version < 0) throw new Error("Invalid Agent Experience storage schema version");
	return version;
}

export function assertSupportedStorageVersion(db: any): number {
	const version = readStorageSchemaVersion(db);
	if (version > STORAGE_SCHEMA_VERSION) throw new Error(`Agent Experience storage schema is newer than this extension: expected <= ${STORAGE_SCHEMA_VERSION}, got ${version}`);
	return version;
}

export function applyStorageMigrations(db: any, now = new Date().toISOString()): void {
	const beforeVersion = assertSupportedStorageVersion(db);
	if (beforeVersion === STORAGE_SCHEMA_VERSION) return;
	db.exec("BEGIN IMMEDIATE");
	try {
		db.exec("CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
		for (const table of USER_TABLES) migrateUserTable(db, table, now);
		db.exec(STORAGE_SCHEMA_SQL);
		if (beforeVersion < 7) migrateApprovedHabitsToExperiences(db, now);
		if (beforeVersion < 8) recoverDamagedApprovedHabits(db, now);
		const existing = db.prepare("SELECT version FROM migrations WHERE version = ?").get(STORAGE_SCHEMA_VERSION);
		if (!existing) db.prepare("INSERT INTO migrations (version, applied_at) VALUES (?, ?)").run(STORAGE_SCHEMA_VERSION, now);
		db.exec(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION}`);
		db.exec("COMMIT");
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {}
		throw error;
	}
}
