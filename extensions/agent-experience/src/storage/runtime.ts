import { writeFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

export interface ExperienceDatabaseOpenOptions {
	create?: boolean;
	readOnly?: boolean;
	timeout?: number;
}

interface BunDatabase extends DatabaseSync {
	serialize(): Uint8Array;
}

interface BunSqliteRuntime {
	kind: "bun";
	Database: new (path: string, options?: { create?: boolean; readonly?: boolean; readwrite?: boolean }) => BunDatabase;
}

interface NodeSqliteRuntime {
	kind: "node";
	DatabaseSync: new (path: string, options?: { open?: boolean; readOnly?: boolean; timeout?: number }) => DatabaseSync;
	backup: (db: DatabaseSync, path: string, options?: { rate?: number }) => Promise<void>;
}

export type ExperienceSqliteRuntime = BunSqliteRuntime | NodeSqliteRuntime;

type HostApi = { host?: unknown };
type RuntimeGlobal = { Bun?: { version?: unknown } };

export function resolveAgentExperienceHost(api: HostApi, runtime: RuntimeGlobal = globalThis): "pi" | "omp" {
	if (api.host === "omp") return "omp";
	if (api.host === "pi") return "pi";
	return typeof runtime.Bun?.version === "string" ? "omp" : "pi";
}

async function loadExperienceSqliteRuntime(): Promise<ExperienceSqliteRuntime> {
	if (resolveAgentExperienceHost({}, globalThis) === "omp") {
		// Platform-specific built-ins cannot be statically imported by both hosts.
		const specifier = "bun:sqlite";
		const sqlite = await import(specifier) as { Database?: BunSqliteRuntime["Database"] };
		if (typeof sqlite.Database !== "function") throw new Error("bun:sqlite Database unavailable");
		return { kind: "bun", Database: sqlite.Database };
	}
	// Platform-specific built-ins cannot be statically imported by both hosts.
	const sqlite = await import("node:sqlite");
	if (typeof sqlite.DatabaseSync !== "function" || typeof sqlite.backup !== "function") throw new Error("node:sqlite DatabaseSync unavailable");
	return { kind: "node", DatabaseSync: sqlite.DatabaseSync, backup: sqlite.backup };
}

export async function openExperienceDatabaseWithRuntime(
	path: string,
	options: ExperienceDatabaseOpenOptions = {},
	runtime?: ExperienceSqliteRuntime,
): Promise<DatabaseSync> {
	const sqlite = runtime ?? await loadExperienceSqliteRuntime();
	if (sqlite.kind === "node") {
		return new sqlite.DatabaseSync(path, {
			open: true,
			readOnly: options.readOnly,
			timeout: options.timeout,
		});
	}
	const db = new sqlite.Database(path, options.readOnly
		? { readonly: true }
		: { create: options.create === true, readwrite: true });
	if (options.timeout !== undefined) db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.timeout))}`);
	return db;
}

export async function backupExperienceDatabaseWithRuntime(
	db: DatabaseSync,
	path: string,
	runtime?: ExperienceSqliteRuntime,
): Promise<void> {
	const sqlite = runtime ?? await loadExperienceSqliteRuntime();
	if (sqlite.kind === "node") {
		await sqlite.backup(db, path, { rate: 100 });
		return;
	}
	const bytes = (db as BunDatabase).serialize();
	await writeFile(path, bytes, { flag: "wx" });
}
