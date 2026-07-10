import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { canonicalJson, checksumJson, sha256Hex } from "./checksum.ts";
import { containsUnredactedSensitiveText } from "./redaction.ts";
import { STORAGE_SCHEMA_VERSION } from "./schema.ts";
import { withOwnedLock } from "./locks.ts";
import {
	assertPathInsidePrivateRoot,
	chmodSensitiveFile,
	copySensitiveFileWithinRoot,
	ensurePrivateRoot,
	openSensitiveFileForWrite,
	resolvePrivatePath,
	PRIVATE_DIR_MODE,
} from "./private-root.ts";

const BACKUP_VERSION = 2;
const BACKUP_V2_ARTIFACTS = new Set(["ledger.sqlite"]);
const BACKUP_V1_ARTIFACTS = new Set(["ledger.sqlite", "ledger.sqlite-wal", "ledger.sqlite-shm", "observations.jsonl"]);
const LEGACY_INSTALL_ARTIFACTS = new Set(["ledger.sqlite", "observations.jsonl"]);
const LIVE_RESET_ARTIFACTS = [
	"ledger.sqlite",
	"ledger.sqlite-wal",
	"ledger.sqlite-shm",
	"observations.jsonl",
	"observations.idx",
	"observations-tail.json",
	"observations-rotation.json",
	"observation-archive",
	"recovered-tails",
] as const;
const RESTORE_JOURNAL = ".restore-journal.json";
const MAINTENANCE_LOCK = "maintenance";

interface BackupArtifact {
	name: string;
	checksum: string;
	bytes: number;
}

interface BackupManifestBase {
	backup_id: string;
	created_at: string;
	storage_version: number;
	storage_schema_version?: number;
	privacy?: { observation_records: "excluded_short_retention" };
	artifacts: BackupArtifact[];
}

interface BackupManifest extends BackupManifestBase {
	manifest_checksum?: string;
}

interface RestoreOriginal {
	name: string;
	present: boolean;
	kind?: "file" | "directory";
	bytes?: number;
	checksum?: string;
}

interface RestoreJournalBase {
	schema_version: 1;
	token: string;
	backup_id: string;
	phase: "prepared" | "live_moved" | "installed" | "committed";
	storage_version: number;
	originals: RestoreOriginal[];
	install_artifacts: string[];
	created_at: string;
	updated_at: string;
}

interface RestoreJournal extends RestoreJournalBase {
	journal_checksum: string;
}

export interface RestoreBackupOptions {
	allowOverwrite?: boolean;
	confirmDatabaseClosed?: boolean;
	_testFailurePhase?: RestoreJournalBase["phase"];
	_testSimulateCrash?: boolean;
}

function validateBackupId(id: string): string {
	const value = String(id || "").trim();
	if (!/^[A-Za-z0-9._-]+$/.test(value) || value.includes("..")) throw new Error("Invalid Agent Experience backup id");
	return value;
}

function validateToken(value: unknown): string {
	const token = String(value || "");
	if (!/^[0-9a-f-]{36}$/i.test(token)) throw new Error("Invalid Agent Experience restore token");
	return token;
}

async function pathKind(path: string): Promise<"file" | "directory" | null> {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink()) throw new Error(`Refusing symlinked Agent Experience path: ${path}`);
		if (info.isFile()) return "file";
		if (info.isDirectory()) return "directory";
		throw new Error(`Unsupported Agent Experience filesystem object: ${path}`);
	} catch (error: any) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

async function writeJsonAtomic(root: string, path: string, value: unknown): Promise<void> {
	await assertPathInsidePrivateRoot(root, path);
	const temp = `${path}.tmp-${randomUUID()}`;
	await assertPathInsidePrivateRoot(root, temp);
	const handle = await openSensitiveFileForWrite(root, temp);
	try {
		await handle.writeFile(canonicalJson(value), "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temp, path);
	await chmodSensitiveFile(path);
}

function manifestChecksum(base: BackupManifestBase): string {
	return checksumJson({ kind: "agent_experience_backup_manifest_v2", ...base });
}

function journalChecksum(base: RestoreJournalBase): string {
	return checksumJson({ kind: "agent_experience_restore_journal_v1", ...base });
}

async function fileArtifact(path: string, name: string): Promise<BackupArtifact> {
	const info = await lstat(path);
	if (info.isSymbolicLink()) throw new Error(`Refusing symlinked backup artifact: ${name}`);
	if (!info.isFile()) throw new Error(`Backup artifact is not a regular file: ${name}`);
	const bytes = await readFile(path);
	return { name, checksum: sha256Hex(bytes), bytes: bytes.length };
}

async function loadSqliteRuntime() {
	const sqlite = await import("node:sqlite");
	if (typeof sqlite.DatabaseSync !== "function" || typeof sqlite.backup !== "function") throw new Error("Agent Experience SQLite backup API unavailable");
	return sqlite;
}

async function verifySqliteFile(path: string, options: { requireCurrent?: boolean } = {}): Promise<{ userVersion: number }> {
	const { DatabaseSync } = await loadSqliteRuntime();
	const db = new DatabaseSync(path, { open: true, readOnly: true, timeout: 5_000 });
	try {
		const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
		if (!Number.isInteger(version) || version < 0 || version > STORAGE_SCHEMA_VERSION) throw new Error(`Unsupported backup storage schema version: ${version}`);
		if (options.requireCurrent && version !== STORAGE_SCHEMA_VERSION) throw new Error(`Backup storage schema mismatch: expected ${STORAGE_SCHEMA_VERSION}, got ${version}`);
		const rows = db.prepare("PRAGMA integrity_check").all();
		if (rows.length !== 1 || String(rows[0]?.integrity_check || "").toLowerCase() !== "ok") throw new Error("Backup SQLite integrity check failed");
		return { userVersion: version };
	} finally {
		db.close();
	}
}

async function ensurePrivateDirectory(root: string, path: string, recursive = false): Promise<void> {
	await assertPathInsidePrivateRoot(root, path);
	await mkdir(path, { recursive, mode: PRIVATE_DIR_MODE });
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Agent Experience path is not a private directory: ${path}`);
}

export async function createBackup(root: string, options: { backupId?: string; createdAt?: string } = {}) {
	const privateRoot = await ensurePrivateRoot(root);
	return withOwnedLock(privateRoot, MAINTENANCE_LOCK, async () => {
		const backupId = validateBackupId(options.backupId || `backup-${Date.now()}`);
		const dbPath = resolvePrivatePath(privateRoot, "ledger.sqlite");
		if (await pathKind(dbPath) !== "file") throw new Error("Agent Experience ledger missing; nothing to back up");
		const backupsRoot = resolvePrivatePath(privateRoot, "backups");
		await ensurePrivateDirectory(privateRoot, backupsRoot, true);
		const backupDir = resolvePrivatePath(privateRoot, "backups", backupId);
		if (await pathKind(backupDir)) throw new Error(`Agent Experience backup already exists: ${backupId}`);
		const token = randomUUID();
		const stagingDir = resolvePrivatePath(privateRoot, "backups", `.staging-${token}`);
		await ensurePrivateDirectory(privateRoot, stagingDir);
		try {
			const snapshotPath = resolvePrivatePath(privateRoot, "backups", `.staging-${token}`, "ledger.sqlite");
			const { DatabaseSync, backup: sqliteBackup } = await loadSqliteRuntime();
			const sourceDb = new DatabaseSync(dbPath, { open: true, timeout: 5_000 });
			let sourceVersion: number;
			try {
				sourceVersion = Number(sourceDb.prepare("PRAGMA user_version").get()?.user_version ?? 0);
				if (!Number.isInteger(sourceVersion) || sourceVersion < 0 || sourceVersion > STORAGE_SCHEMA_VERSION) throw new Error(`Unsupported Agent Experience storage schema version: ${sourceVersion}`);
				await sqliteBackup(sourceDb, snapshotPath, { rate: 100 });
			} finally {
				sourceDb.close();
			}
			await chmodSensitiveFile(snapshotPath);
			const verified = await verifySqliteFile(snapshotPath, { requireCurrent: sourceVersion === STORAGE_SCHEMA_VERSION });
			const artifact = await fileArtifact(snapshotPath, "ledger.sqlite");
			const base: BackupManifestBase = {
				backup_id: backupId,
				created_at: options.createdAt || new Date().toISOString(),
				storage_version: BACKUP_VERSION,
				storage_schema_version: verified.userVersion,
				privacy: { observation_records: "excluded_short_retention" },
				artifacts: [artifact],
			};
			const manifest: BackupManifest = { ...base, manifest_checksum: manifestChecksum(base) };
			if (containsUnredactedSensitiveText(manifest)) throw new Error("Backup manifest contains unredacted sensitive text");
			const stagingManifest = resolvePrivatePath(privateRoot, "backups", `.staging-${token}`, "manifest.json");
			await writeJsonAtomic(privateRoot, stagingManifest, manifest);
			await rename(stagingDir, backupDir);
			const manifestPath = resolvePrivatePath(privateRoot, "backups", backupId, "manifest.json");
			return { backupId, backupDir, manifest, manifestPath };
		} catch (error) {
			await rm(stagingDir, { recursive: true, force: true });
			throw error;
		}
	}, { waitMs: 10_000 });
}

function parseManifest(text: string, backupId: string): BackupManifest {
	let manifest: BackupManifest;
	try {
		manifest = JSON.parse(text);
	} catch {
		throw new Error("Invalid Agent Experience backup manifest JSON");
	}
	if (!manifest || typeof manifest !== "object" || manifest.backup_id !== backupId) throw new Error("Backup manifest id mismatch");
	if (!Number.isInteger(manifest.storage_version) || ![1, BACKUP_VERSION].includes(manifest.storage_version)) throw new Error("Unsupported Agent Experience backup manifest version");
	if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) throw new Error("Backup manifest has no artifacts");
	if (manifest.storage_version === BACKUP_VERSION) {
		const { manifest_checksum, ...base } = manifest as BackupManifest & Record<string, unknown>;
		if (typeof manifest_checksum !== "string" || manifest_checksum !== manifestChecksum(base as unknown as BackupManifestBase)) throw new Error("Backup manifest checksum mismatch");
		if (manifest.privacy?.observation_records !== "excluded_short_retention") throw new Error("Backup privacy manifest mismatch");
	}
	return manifest;
}

export async function prevalidateBackup(root: string, backupIdRaw: string) {
	const privateRoot = await ensurePrivateRoot(root);
	const backupId = validateBackupId(backupIdRaw);
	const backupDir = resolvePrivatePath(privateRoot, "backups", backupId);
	if (await pathKind(backupDir) !== "directory") throw new Error(`Agent Experience backup missing: ${backupId}`);
	const manifestPath = resolvePrivatePath(privateRoot, "backups", backupId, "manifest.json");
	if (await pathKind(manifestPath) !== "file") throw new Error("Backup manifest is not a regular file");
	const manifest = parseManifest(await readFile(manifestPath, "utf8"), backupId);
	const allowed = manifest.storage_version === BACKUP_VERSION ? BACKUP_V2_ARTIFACTS : BACKUP_V1_ARTIFACTS;
	const names = new Set<string>();
	const validated: Array<BackupArtifact & { path: string; install: boolean }> = [];
	for (const raw of manifest.artifacts) {
		const name = String(raw?.name || "");
		if (!allowed.has(name) || basename(name) !== name) throw new Error(`Unknown backup artifact: ${name}`);
		if (names.has(name)) throw new Error(`Duplicate backup artifact: ${name}`);
		names.add(name);
		if (!Number.isInteger(raw.bytes) || raw.bytes < 0 || typeof raw.checksum !== "string" || !/^[0-9a-f]{64}$/i.test(raw.checksum)) throw new Error(`Invalid backup artifact metadata: ${name}`);
		const path = resolvePrivatePath(privateRoot, "backups", backupId, name);
		const actual = await fileArtifact(path, name);
		if (actual.bytes !== raw.bytes) throw new Error(`Backup size mismatch: ${name}`);
		if (actual.checksum !== raw.checksum) throw new Error(`Backup checksum mismatch: ${name}`);
		if (name === "observations.jsonl" && containsUnredactedSensitiveText((await readFile(path)).toString("utf8"))) throw new Error("Refusing unredacted legacy observation backup");
		validated.push({ ...actual, path, install: manifest.storage_version === BACKUP_VERSION || LEGACY_INSTALL_ARTIFACTS.has(name) });
	}
	if (!names.has("ledger.sqlite")) throw new Error("Backup ledger artifact missing");
	if (manifest.storage_version === BACKUP_VERSION && (names.size !== 1 || !names.has("ledger.sqlite"))) throw new Error("Storage-v2 backup contains unexpected artifacts");
	const sqlite = await verifySqliteFile(validated.find((item) => item.name === "ledger.sqlite")!.path);
	if (manifest.storage_schema_version !== undefined && Number(manifest.storage_schema_version) !== sqlite.userVersion) throw new Error("Backup storage schema metadata mismatch");
	return { privateRoot, backupId, backupDir, manifestPath, manifest, artifacts: validated, storageSchemaVersion: sqlite.userVersion };
}

export async function listBackups(root: string) {
	const privateRoot = await ensurePrivateRoot(root);
	const backupsRoot = resolvePrivatePath(privateRoot, "backups");
	const entries = await readdir(backupsRoot).catch((error: any) => {
		if (error?.code === "ENOENT") return [];
		throw error;
	});
	const manifests: BackupManifest[] = [];
	for (const entry of entries.sort()) {
		if (entry.startsWith(".")) continue;
		const validated = await prevalidateBackup(privateRoot, validateBackupId(entry));
		manifests.push(validated.manifest);
	}
	return manifests;
}

async function captureOriginals(root: string): Promise<RestoreOriginal[]> {
	const originals: RestoreOriginal[] = [];
	for (const name of LIVE_RESET_ARTIFACTS) {
		const path = resolvePrivatePath(root, name);
		const kind = await pathKind(path);
		if (!kind) {
			originals.push({ name, present: false });
			continue;
		}
		if (kind === "directory") {
			originals.push({ name, present: true, kind: "directory" });
			continue;
		}
		const artifact = await fileArtifact(path, name);
		originals.push({ name, present: true, kind: "file", bytes: artifact.bytes, checksum: artifact.checksum });
	}
	return originals;
}

function withJournalChecksum(base: RestoreJournalBase): RestoreJournal {
	return { ...base, journal_checksum: journalChecksum(base) };
}

async function writeRestoreJournal(root: string, journal: RestoreJournal): Promise<void> {
	await writeJsonAtomic(root, resolvePrivatePath(root, RESTORE_JOURNAL), journal);
}

async function readRestoreJournal(root: string): Promise<RestoreJournal | null> {
	const path = resolvePrivatePath(root, RESTORE_JOURNAL);
	if (!(await pathKind(path))) return null;
	if (await pathKind(path) !== "file") throw new Error("Restore journal is not a regular file");
	let journal: RestoreJournal;
	try {
		journal = JSON.parse(await readFile(path, "utf8"));
	} catch {
		throw new Error("Invalid Agent Experience restore journal JSON");
	}
	const { journal_checksum, ...base } = journal as RestoreJournal & Record<string, unknown>;
	if (journal_checksum !== journalChecksum(base as unknown as RestoreJournalBase)) throw new Error("Restore journal checksum mismatch");
	validateToken(journal.token);
	validateBackupId(journal.backup_id);
	if (journal.schema_version !== 1 || !["prepared", "live_moved", "installed", "committed"].includes(journal.phase)) throw new Error("Unsupported restore journal");
	if (!Array.isArray(journal.originals) || !Array.isArray(journal.install_artifacts)) throw new Error("Invalid restore journal contents");
	for (const original of journal.originals) if (!LIVE_RESET_ARTIFACTS.includes(original.name as any)) throw new Error(`Unknown restore target: ${original.name}`);
	return journal;
}

async function updateJournal(root: string, journal: RestoreJournal, phase: RestoreJournalBase["phase"]): Promise<RestoreJournal> {
	const { journal_checksum: _ignored, ...base } = journal;
	const next = withJournalChecksum({ ...base, phase, updated_at: new Date().toISOString() });
	await writeRestoreJournal(root, next);
	return next;
}

async function removeLiveSqliteSidecars(root: string): Promise<void> {
	await rm(resolvePrivatePath(root, "ledger.sqlite-wal"), { force: true });
	await rm(resolvePrivatePath(root, "ledger.sqlite-shm"), { force: true });
}

async function cleanupRestorePaths(root: string, token: string): Promise<void> {
	await rm(resolvePrivatePath(root, `.restore-stage-${token}`), { recursive: true, force: true });
	await rm(resolvePrivatePath(root, `.restore-rollback-${token}`), { recursive: true, force: true });
	await rm(resolvePrivatePath(root, RESTORE_JOURNAL), { force: true });
}

async function rollbackInterruptedRestore(root: string, journal: RestoreJournal): Promise<void> {
	const rollbackDir = resolvePrivatePath(root, `.restore-rollback-${journal.token}`);
	for (const original of journal.originals) {
		const live = resolvePrivatePath(root, original.name);
		const rollback = resolvePrivatePath(root, `.restore-rollback-${journal.token}`, original.name);
		if (await pathKind(rollback)) {
			await rm(live, { recursive: true, force: true });
			await rename(rollback, live);
			if (await pathKind(live) === "file") await chmodSensitiveFile(live);
			continue;
		}
		if (!original.present) {
			await rm(live, { recursive: true, force: true });
			continue;
		}
		const liveKind = await pathKind(live);
		if (original.kind === "directory") {
			if (liveKind !== "directory") throw new Error(`Cannot recover missing original restore directory: ${original.name}`);
			continue;
		}
		if (liveKind !== "file") throw new Error(`Cannot recover missing original restore target: ${original.name}`);
		const actual = await fileArtifact(live, original.name);
		if (actual.bytes !== original.bytes || actual.checksum !== original.checksum) throw new Error(`Cannot verify original restore target: ${original.name}`);
	}
	await rm(rollbackDir, { recursive: true, force: true });
	await rm(resolvePrivatePath(root, `.restore-stage-${journal.token}`), { recursive: true, force: true });
	await rm(resolvePrivatePath(root, RESTORE_JOURNAL), { force: true });
}

async function recoverInterruptedRestoreLocked(root: string): Promise<{ recovered: boolean; outcome?: "old" | "new" }> {
	const journal = await readRestoreJournal(root);
	if (!journal) return { recovered: false };
	if (journal.phase === "committed") {
		try {
			await verifySqliteFile(resolvePrivatePath(root, "ledger.sqlite"));
			await removeLiveSqliteSidecars(root);
		} catch {
			await rollbackInterruptedRestore(root, journal);
			return { recovered: true, outcome: "old" };
		}
		await cleanupRestorePaths(root, journal.token);
		return { recovered: true, outcome: "new" };
	}
	await rollbackInterruptedRestore(root, journal);
	return { recovered: true, outcome: "old" };
}

export async function recoverInterruptedRestore(root: string) {
	const privateRoot = await ensurePrivateRoot(root);
	if (!(await pathKind(resolvePrivatePath(privateRoot, RESTORE_JOURNAL)))) return { recovered: false };
	return withOwnedLock(privateRoot, MAINTENANCE_LOCK, () => recoverInterruptedRestoreLocked(privateRoot), { waitMs: 10_000 });
}

function maybeTestFailure(options: RestoreBackupOptions, phase: RestoreJournalBase["phase"]): void {
	if (options._testFailurePhase === phase) throw new Error(`Injected restore failure after ${phase}`);
}

export async function restoreBackup(root: string, backupIdRaw: string, options: RestoreBackupOptions = {}) {
	if (!options.allowOverwrite) throw new Error("Agent Experience restore requires allowOverwrite=true");
	if (!options.confirmDatabaseClosed) throw new Error("Agent Experience restore of SQLite artifacts requires confirmDatabaseClosed=true");
	const privateRoot = await ensurePrivateRoot(root);
	return withOwnedLock(privateRoot, MAINTENANCE_LOCK, async () => {
		if (await pathKind(resolvePrivatePath(privateRoot, RESTORE_JOURNAL))) await recoverInterruptedRestoreLocked(privateRoot);
		const validated = await prevalidateBackup(privateRoot, backupIdRaw);
		const token = randomUUID();
		const stageDir = resolvePrivatePath(privateRoot, `.restore-stage-${token}`);
		const rollbackDir = resolvePrivatePath(privateRoot, `.restore-rollback-${token}`);
		await ensurePrivateDirectory(privateRoot, stageDir);
		await ensurePrivateDirectory(privateRoot, rollbackDir);
		let journal: RestoreJournal | null = null;
		try {
			const installArtifacts = validated.artifacts.filter((artifact) => artifact.install).map((artifact) => artifact.name);
			for (const artifact of validated.artifacts.filter((item) => item.install)) {
				const target = resolvePrivatePath(privateRoot, `.restore-stage-${token}`, artifact.name);
				await copyFile(artifact.path, target);
				await chmodSensitiveFile(target);
			}
			await verifySqliteFile(resolvePrivatePath(privateRoot, `.restore-stage-${token}`, "ledger.sqlite"));
			const now = new Date().toISOString();
			journal = withJournalChecksum({
				schema_version: 1,
				token,
				backup_id: validated.backupId,
				phase: "prepared",
				storage_version: validated.manifest.storage_version,
				originals: await captureOriginals(privateRoot),
				install_artifacts: installArtifacts,
				created_at: now,
				updated_at: now,
			});
			await writeRestoreJournal(privateRoot, journal);
			maybeTestFailure(options, "prepared");
			for (const original of journal.originals.filter((item) => item.present)) {
				await rename(resolvePrivatePath(privateRoot, original.name), resolvePrivatePath(privateRoot, `.restore-rollback-${token}`, original.name));
			}
			journal = await updateJournal(privateRoot, journal, "live_moved");
			maybeTestFailure(options, "live_moved");
			for (const name of installArtifacts) {
				await rename(resolvePrivatePath(privateRoot, `.restore-stage-${token}`, name), resolvePrivatePath(privateRoot, name));
				await chmodSensitiveFile(resolvePrivatePath(privateRoot, name));
			}
			if (validated.manifest.storage_version === BACKUP_VERSION) {
				const { initializeFreshObservationGeneration } = await import("./observations.ts");
				await initializeFreshObservationGeneration(privateRoot);
			}
			journal = await updateJournal(privateRoot, journal, "installed");
			maybeTestFailure(options, "installed");
			await verifySqliteFile(resolvePrivatePath(privateRoot, "ledger.sqlite"));
			await removeLiveSqliteSidecars(privateRoot);
			journal = await updateJournal(privateRoot, journal, "committed");
			maybeTestFailure(options, "committed");
			await cleanupRestorePaths(privateRoot, token);
			return { backupId: validated.backupId, restored: installArtifacts, storageVersion: validated.manifest.storage_version };
		} catch (error) {
			if (journal && !options._testSimulateCrash) await recoverInterruptedRestoreLocked(privateRoot);
			else if (!journal) {
				await rm(stageDir, { recursive: true, force: true });
				await rm(rollbackDir, { recursive: true, force: true });
			}
			throw error;
		}
	}, { waitMs: 10_000 });
}
