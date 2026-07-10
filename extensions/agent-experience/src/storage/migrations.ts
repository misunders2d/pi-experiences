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
