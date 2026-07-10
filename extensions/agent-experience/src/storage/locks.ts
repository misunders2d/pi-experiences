import { randomUUID } from "node:crypto";
import { hostname as systemHostname } from "node:os";
import { lstat, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { canonicalJson } from "./checksum.ts";
import { ensurePrivateRoot, openSensitiveFileForWrite, resolvePrivatePath } from "./private-root.ts";

export interface OwnedLockOptions {
	waitMs?: number;
	retryMs?: number;
	malformedGraceMs?: number;
	staleMs?: number;
	now?: () => number;
	pid?: number;
	hostname?: string;
}

export interface OwnedLock {
	name: string;
	path: string;
	token: string;
	release(): Promise<void>;
}

interface LockOwner {
	token: string;
	pid: number;
	hostname: string;
	created_at: string;
}

function validateLockName(name: string): string {
	const value = String(name || "").trim();
	if (!/^[A-Za-z0-9._-]+$/.test(value) || value.includes("..")) throw new Error("Invalid Agent Experience lock name");
	return value;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		return error?.code === "EPERM";
	}
}

async function readOwner(lockPath: string): Promise<LockOwner | null> {
	try {
		const info = await lstat(lockPath);
		if (info.isSymbolicLink()) throw new Error("Agent Experience lock path is symlinked");
		if (!info.isDirectory()) return null;
		const raw = JSON.parse(await readFile(resolvePrivatePath(lockPath, "owner.json"), "utf8"));
		if (!raw || typeof raw !== "object") return null;
		if (typeof raw.token !== "string" || !/^[0-9a-f-]{36}$/i.test(raw.token)) return null;
		if (!Number.isInteger(raw.pid) || raw.pid <= 0) return null;
		if (typeof raw.hostname !== "string" || !raw.hostname || raw.hostname.length > 255) return null;
		if (typeof raw.created_at !== "string" || !Number.isFinite(Date.parse(raw.created_at))) return null;
		return { token: raw.token, pid: raw.pid, hostname: raw.hostname, created_at: raw.created_at };
	} catch (error: any) {
		if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
		throw error;
	}
}

async function reclaimDirectory(root: string, lockPath: string, token: string): Promise<boolean> {
	const tombstone = resolvePrivatePath(root, `.lock-reclaim-${token}`);
	try {
		await rename(lockPath, tombstone);
	} catch (error: any) {
		if (error?.code === "ENOENT") return true;
		if (error?.code === "EEXIST") return false;
		throw error;
	}
	await rm(tombstone, { recursive: true, force: true });
	return true;
}

async function maybeReclaim(root: string, lockPath: string, options: Required<Pick<OwnedLockOptions, "malformedGraceMs" | "staleMs">> & { now: () => number; hostname: string }): Promise<boolean> {
	let info;
	try {
		info = await stat(lockPath);
	} catch (error: any) {
		if (error?.code === "ENOENT") return true;
		throw error;
	}
	const owner = await readOwner(lockPath);
	if (!owner) {
		if (options.now() - info.mtimeMs < options.malformedGraceMs) return false;
		return reclaimDirectory(root, lockPath, randomUUID());
	}
	if (owner.hostname !== options.hostname) throw new Error("Agent Experience lock belongs to another host; manual recovery required");
	const ageMs = options.now() - Date.parse(owner.created_at);
	if (!Number.isFinite(ageMs) || ageMs < -60_000) throw new Error("Agent Experience lock has invalid time metadata; manual recovery required");
	if (ageMs >= options.staleMs) return reclaimDirectory(root, lockPath, randomUUID());
	if (isProcessAlive(owner.pid)) return false;
	return reclaimDirectory(root, lockPath, randomUUID());
}

export async function acquireOwnedLock(root: string, nameRaw: string, options: OwnedLockOptions = {}): Promise<OwnedLock> {
	const privateRoot = await ensurePrivateRoot(root);
	const name = validateLockName(nameRaw);
	const lockPath = resolvePrivatePath(privateRoot, `.${name}.lock`);
	const waitMs = Math.max(0, Math.min(120_000, Math.trunc(options.waitMs ?? 2_000)));
	const retryMs = Math.max(5, Math.min(1_000, Math.trunc(options.retryMs ?? 25)));
	const malformedGraceMs = Math.max(0, Math.min(60_000, Math.trunc(options.malformedGraceMs ?? 2_000)));
	const staleMs = Math.max(1_000, Math.min(24 * 60 * 60_000, Math.trunc(options.staleMs ?? 2 * 60 * 60_000)));
	const now = options.now || Date.now;
	const pid = options.pid ?? process.pid;
	const hostname = options.hostname || systemHostname();
	const token = randomUUID();
	const started = now();

	for (;;) {
		try {
			await mkdir(lockPath, { mode: 0o700 });
			const owner: LockOwner = { token, pid, hostname, created_at: new Date(now()).toISOString() };
			try {
				const handle = await openSensitiveFileForWrite(privateRoot, resolvePrivatePath(lockPath, "owner.json"));
				try {
					await handle.writeFile(canonicalJson(owner), "utf8");
					await handle.sync();
				} finally {
					await handle.close();
				}
			} catch (error) {
				await rm(lockPath, { recursive: true, force: true });
				throw error;
			}
			let released = false;
			return {
				name,
				path: lockPath,
				token,
				async release() {
					if (released) return;
					const current = await readOwner(lockPath);
					if (!current || current.token !== token) throw new Error("Agent Experience lock ownership changed; refusing release");
					const releasePath = resolvePrivatePath(privateRoot, `.lock-release-${token}`);
					await rename(lockPath, releasePath);
					const moved = await readOwner(releasePath);
					if (!moved || moved.token !== token) {
						await rename(releasePath, lockPath).catch(() => undefined);
						throw new Error("Agent Experience lock ownership changed during release");
					}
					await rm(releasePath, { recursive: true, force: true });
					released = true;
				},
			};
		} catch (error: any) {
			if (error?.code !== "EEXIST") throw error;
			if (await maybeReclaim(privateRoot, lockPath, { malformedGraceMs, staleMs, now, hostname })) continue;
			if (now() - started >= waitMs) throw new Error(`Could not acquire Agent Experience ${name} lock`);
			await sleep(retryMs);
		}
	}
}

export async function withOwnedLock<T>(root: string, name: string, fn: () => Promise<T>, options: OwnedLockOptions = {}): Promise<T> {
	const lock = await acquireOwnedLock(root, name, options);
	try {
		return await fn();
	} finally {
		await lock.release();
	}
}
