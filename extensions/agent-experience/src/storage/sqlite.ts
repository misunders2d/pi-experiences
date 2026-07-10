import { chmod, lstat, stat } from "node:fs/promises";
import { resolvePrivatePath, ensurePrivateRoot, normalizeUserId, SENSITIVE_FILE_MODE } from "./private-root.ts";
import { checksumJson, canonicalJson } from "./checksum.ts";
import { redactJson } from "./redaction.ts";
import { applyStorageMigrations, assertSupportedStorageVersion, readStorageSchemaVersion } from "./migrations.ts";
import { recoverInterruptedRestore } from "./backup.ts";
import { STORAGE_REQUIRED_INDEXES, STORAGE_REQUIRED_TABLES, STORAGE_SCHEMA_VERSION, STORAGE_STATUS_VALUES, STORAGE_TYPED_FIELDS, USER_SCOPED_TABLES, type StorageStatus } from "./schema.ts";

export interface InitExperienceStorageOptions {
	allowInit: boolean;
	userId?: string;
}

export interface TypedStorageRowInput {
	id: string;
	user_id: string;
	record_kind: string;
	schema_version: number;
	status: StorageStatus;
	habit_id: string | null;
	condition: string | null;
	behavior: string | null;
	polarity: -1 | 0 | 1;
	confidence_bp: number;
	activation: number;
	staleness: number;
	data_json: string;
	checksum: string;
	created_at: string;
	updated_at: string;
}

const STATUS_SET = new Set<string>(STORAGE_STATUS_VALUES);
const TYPED_FIELD_SET = new Set<string>(STORAGE_TYPED_FIELDS as readonly string[]);

export async function loadSqlite() {
	try {
		const sqlite = await import("node:sqlite");
		if (typeof sqlite.DatabaseSync !== "function") throw new Error("node:sqlite DatabaseSync unavailable");
		return sqlite;
	} catch (error: any) {
		throw new Error(`Agent Experience SQLite unavailable: ${error?.message || error}`);
	}
}

async function ledgerExists(dbPath: string): Promise<boolean> {
	try {
		const info = await lstat(dbPath);
		if (!info.isFile() || info.isSymbolicLink()) throw new Error("Agent Experience ledger is not a regular private file");
		return true;
	} catch (error: any) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

function verifyCurrentStorageSchema(db: any): void {
	for (const table of STORAGE_REQUIRED_TABLES) {
		if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) throw new Error(`Agent Experience current schema is missing table: ${table}`);
	}
	for (const index of STORAGE_REQUIRED_INDEXES) {
		if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index)) throw new Error(`Agent Experience current schema is missing index: ${index}`);
	}
}

function ensureCurrentStorageSchema(db: any): void {
	const version = assertSupportedStorageVersion(db);
	if (version < STORAGE_SCHEMA_VERSION) applyStorageMigrations(db);
	const after = readStorageSchemaVersion(db);
	if (after !== STORAGE_SCHEMA_VERSION) throw new Error(`Agent Experience storage schema mismatch: expected ${STORAGE_SCHEMA_VERSION}, got ${after}`);
	verifyCurrentStorageSchema(db);
}

export async function openExistingExperienceStorage(root: string, options: { userId?: string } = {}) {
	const userId = normalizeUserId(options.userId);
	const privateRoot = await ensurePrivateRoot(root);
	await recoverInterruptedRestore(privateRoot);
	const dbPath = resolvePrivatePath(privateRoot, "ledger.sqlite");
	if (!(await ledgerExists(dbPath))) throw new Error(`Agent Experience ledger missing: ${dbPath}`);
	const sqlite = await loadSqlite();
	const db = new sqlite.DatabaseSync(dbPath, { open: true });
	try {
		assertSupportedStorageVersion(db);
		ensureCurrentStorageSchema(db);
		db.exec("PRAGMA journal_mode=WAL");
	} catch (error) {
		db.close();
		throw error;
	}
	return { db, dbPath, userId, root: privateRoot };
}

export async function initExperienceStorage(root: string, options: InitExperienceStorageOptions) {
	if (!options?.allowInit) throw new Error("Agent Experience storage init requires allowInit=true");
	const userId = normalizeUserId(options.userId);
	const privateRoot = await ensurePrivateRoot(root);
	await recoverInterruptedRestore(privateRoot);
	const dbPath = resolvePrivatePath(privateRoot, "ledger.sqlite");
	const existed = await ledgerExists(dbPath);
	const sqlite = await loadSqlite();
	const db = new sqlite.DatabaseSync(dbPath, { open: true });
	try {
		if (existed) assertSupportedStorageVersion(db);
		ensureCurrentStorageSchema(db);
		db.exec("PRAGMA journal_mode=WAL");
	} catch (error) {
		db.close();
		throw error;
	}
	await chmod(dbPath, SENSITIVE_FILE_MODE);
	return { db, dbPath, userId, root: privateRoot };
}

function stringOrNull(value: unknown, max = 2000): string | null {
	if (value === undefined || value === null) return null;
	const text = String(value);
	if (text.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error("Invalid typed storage string");
	return text;
}

function safeRecordKind(value: unknown): string {
	const text = stringOrNull(value, 160) || "legacy_record_v1";
	if (!/^[A-Za-z0-9._:-]+$/.test(text)) throw new Error("Invalid record_kind");
	return text;
}

function safeSchemaVersion(value: unknown): number {
	const version = value === undefined || value === null ? 1 : Number(value);
	if (!Number.isInteger(version) || version < 1 || version > 1000) throw new Error("Invalid schema_version");
	return version;
}

function safeStatus(value: unknown): StorageStatus {
	const status = String(value ?? "candidate");
	if (!STATUS_SET.has(status)) throw new Error("Invalid status");
	return status as StorageStatus;
}

function safePolarity(value: unknown): -1 | 0 | 1 {
	const polarity = value === undefined || value === null ? 0 : Number(value);
	if (polarity !== -1 && polarity !== 0 && polarity !== 1) throw new Error("Invalid polarity");
	return polarity;
}

function safeConfidenceBp(value: unknown): number {
	const confidence = value === undefined || value === null ? 0 : Number(value);
	if (!Number.isInteger(confidence) || confidence < 0 || confidence > 10000) throw new Error("Invalid confidence_bp");
	return confidence;
}

function safeFiniteNumber(value: unknown, label: string): number {
	const number = value === undefined || value === null ? 0 : Number(value);
	if (!Number.isFinite(number)) throw new Error(`Invalid ${label}`);
	return number;
}

function residualData(data: unknown): unknown {
	if (!data || typeof data !== "object" || Array.isArray(data)) return data ?? {};
	const residual: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
		if (TYPED_FIELD_SET.has(key)) continue;
		residual[key] = value;
	}
	return residual;
}

function storageChecksum(table: string, row: Omit<TypedStorageRowInput, "checksum">): string {
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

export function buildTypedStorageRow(table: "habits" | "evidence" | "contexts", input: { id: string; userId?: string; data: unknown; now?: string; createdAt?: string; updatedAt?: string }): TypedStorageRowInput {
	if (!USER_SCOPED_TABLES.includes(table)) throw new Error(`Unsupported table: ${table}`);
	const userId = normalizeUserId(input.userId);
	const now = input.now || new Date().toISOString();
	const dataRedacted = redactJson(input.data ?? {});
	const record = (dataRedacted && typeof dataRedacted === "object" && !Array.isArray(dataRedacted)) ? dataRedacted as Record<string, unknown> : {};
	const withoutChecksum: Omit<TypedStorageRowInput, "checksum"> = {
		id: input.id,
		user_id: userId,
		record_kind: safeRecordKind(record.record_kind),
		schema_version: safeSchemaVersion(record.schema_version),
		status: safeStatus(record.status),
		habit_id: stringOrNull(record.habit_id ?? record.candidate_id ?? null, 200),
		condition: stringOrNull(record.condition, 2000),
		behavior: stringOrNull(record.behavior, 2000),
		polarity: safePolarity(record.polarity),
		confidence_bp: safeConfidenceBp(record.confidence_bp ?? record.confidence),
		activation: safeFiniteNumber(record.activation, "activation"),
		staleness: safeFiniteNumber(record.staleness, "staleness"),
		data_json: canonicalJson(redactJson(residualData(dataRedacted))),
		created_at: input.createdAt || now,
		updated_at: input.updatedAt || now,
	};
	return { ...withoutChecksum, checksum: storageChecksum(table, withoutChecksum) };
}

export function insertStorageRecord(db: any, table: "habits" | "evidence" | "contexts", input: { id: string; userId?: string; data: unknown; now?: string }) {
	const row = buildTypedStorageRow(table, input);
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
	return { id: row.id, user_id: row.user_id, checksum: row.checksum };
}

export function selectStorageRecordsByUser(db: any, table: "habits" | "evidence" | "contexts", userId: string) {
	if (!USER_SCOPED_TABLES.includes(table)) throw new Error(`Unsupported table: ${table}`);
	return db.prepare(`SELECT id, user_id, record_kind, schema_version, status, habit_id, condition, behavior, polarity, confidence_bp, activation, staleness, data_json, checksum FROM ${table} WHERE user_id = ? ORDER BY id`).all(normalizeUserId(userId));
}

export function selectKnownStorageRecordsByUser(db: any, table: "habits" | "evidence" | "contexts", userId: string, recordKinds: string[], statuses: string[]) {
	if (!USER_SCOPED_TABLES.includes(table)) throw new Error(`Unsupported table: ${table}`);
	if (!recordKinds.length || !statuses.length) return [];
	const kindPlaceholders = recordKinds.map(() => "?").join(", ");
	const statusPlaceholders = statuses.map(() => "?").join(", ");
	return db.prepare(`SELECT id, user_id, record_kind, schema_version, status, habit_id, condition, behavior, polarity, confidence_bp, activation, staleness, data_json, checksum FROM ${table} WHERE user_id = ? AND record_kind IN (${kindPlaceholders}) AND status IN (${statusPlaceholders}) ORDER BY id`)
		.all(normalizeUserId(userId), ...recordKinds, ...statuses);
}

export function getTableInfo(db: any, table: "habits" | "evidence" | "contexts") {
	if (!USER_SCOPED_TABLES.includes(table)) throw new Error(`Unsupported table: ${table}`);
	return db.prepare(`PRAGMA table_info(${table})`).all();
}
