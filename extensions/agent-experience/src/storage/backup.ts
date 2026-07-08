import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { basename } from "node:path";
import { canonicalJson, sha256Hex } from "./checksum.ts";
import { containsUnredactedSensitiveText } from "./redaction.ts";
import {
	chmodSensitiveFile,
	copySensitiveFileWithinRoot,
	ensurePrivateRoot,
	openSensitiveFileForWrite,
	resolvePrivatePath,
} from "./private-root.ts";

const KNOWN_ARTIFACTS = new Set(["ledger.sqlite", "ledger.sqlite-wal", "ledger.sqlite-shm", "observations.jsonl"]);
const TEXT_ARTIFACTS = new Set(["observations.jsonl"]);

function validateBackupId(id: string): string {
	const value = String(id || "").trim();
	if (!/^[A-Za-z0-9._-]+$/.test(value) || value.includes("..")) throw new Error("Invalid Agent Experience backup id");
	return value;
}

async function existingKnownArtifacts(root: string): Promise<string[]> {
	const entries = await readdir(root).catch((error: any) => {
		if (error?.code === "ENOENT") return [];
		throw error;
	});
	return entries.filter((entry) => KNOWN_ARTIFACTS.has(entry)).sort();
}

export async function createBackup(root: string, options: { backupId?: string; createdAt?: string } = {}) {
	const privateRoot = await ensurePrivateRoot(root);
	const backupId = validateBackupId(options.backupId || `backup-${Date.now()}`);
	const backupDir = resolvePrivatePath(privateRoot, "backups", backupId);
	await mkdir(backupDir, { recursive: true, mode: 0o700 });
	const artifacts = [];
	for (const name of await existingKnownArtifacts(privateRoot)) {
		const source = resolvePrivatePath(privateRoot, name);
		const target = resolvePrivatePath(privateRoot, "backups", backupId, name);
		await copySensitiveFileWithinRoot(privateRoot, source, target);
		const bytes = await readFile(target);
		if (TEXT_ARTIFACTS.has(name) && containsUnredactedSensitiveText(bytes.toString("utf8"))) throw new Error(`Refusing to back up unredacted artifact: ${name}`);
		artifacts.push({ name, checksum: sha256Hex(bytes), bytes: bytes.length });
	}
	const manifest = {
		backup_id: backupId,
		created_at: options.createdAt || new Date().toISOString(),
		storage_version: 1,
		artifacts,
	};
	const manifestPath = resolvePrivatePath(privateRoot, "backups", backupId, "manifest.json");
	const handle = await openSensitiveFileForWrite(privateRoot, manifestPath);
	try {
		await handle.writeFile(canonicalJson(manifest), "utf8");
	} finally {
		await handle.close();
	}
	if (containsUnredactedSensitiveText(manifest)) throw new Error("Backup manifest contains unredacted sensitive text");
	return { backupId, backupDir, manifest, manifestPath };
}

export async function listBackups(root: string) {
	const privateRoot = await ensurePrivateRoot(root);
	const backupsRoot = resolvePrivatePath(privateRoot, "backups");
	const entries = await readdir(backupsRoot).catch((error: any) => {
		if (error?.code === "ENOENT") return [];
		throw error;
	});
	const manifests = [];
	for (const entry of entries.sort()) {
		const backupId = validateBackupId(entry);
		const manifestPath = resolvePrivatePath(privateRoot, "backups", backupId, "manifest.json");
		const text = await readFile(manifestPath, "utf8");
		manifests.push(JSON.parse(text));
	}
	return manifests;
}

export async function restoreBackup(root: string, backupIdRaw: string, options: { allowOverwrite?: boolean; confirmDatabaseClosed?: boolean } = {}) {
	if (!options.allowOverwrite) throw new Error("Agent Experience restore requires allowOverwrite=true");
	const privateRoot = await ensurePrivateRoot(root);
	const backupId = validateBackupId(backupIdRaw);
	const manifestPath = resolvePrivatePath(privateRoot, "backups", backupId, "manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	if (manifest.backup_id !== backupId) throw new Error("Backup manifest id mismatch");
	const restored = [];
	if ((manifest.artifacts || []).some((artifact: any) => String(artifact.name).startsWith("ledger.sqlite")) && !options.confirmDatabaseClosed) {
		throw new Error("Agent Experience restore of SQLite artifacts requires confirmDatabaseClosed=true");
	}
	for (const artifact of manifest.artifacts || []) {
		if (!KNOWN_ARTIFACTS.has(artifact.name) || basename(artifact.name) !== artifact.name) throw new Error(`Unknown backup artifact: ${artifact.name}`);
		const source = resolvePrivatePath(privateRoot, "backups", backupId, artifact.name);
		const bytes = await readFile(source);
		if (sha256Hex(bytes) !== artifact.checksum) throw new Error(`Backup checksum mismatch: ${artifact.name}`);
		const target = resolvePrivatePath(privateRoot, artifact.name);
		await copyFile(source, target);
		await chmodSensitiveFile(target);
		restored.push(artifact.name);
	}
	return { backupId, restored };
}
