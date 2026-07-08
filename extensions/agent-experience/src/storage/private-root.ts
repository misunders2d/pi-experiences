import { chmod, copyFile, lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { getAgentExperiencePaths } from "../paths.ts";

export const PRIVATE_DIR_MODE = 0o700;
export const SENSITIVE_FILE_MODE = 0o600;

export function normalizeUserId(userId: string | undefined | null = "owner"): string {
	const value = String(userId ?? "owner").trim() || "owner";
	if (/[/\\\0\r\n\t]/.test(value) || /[\x00-\x1f\x7f]/.test(value)) {
		throw new Error("Invalid Agent Experience userId");
	}
	return value;
}

export function getPrivateStateRoot(env: NodeJS.ProcessEnv = process.env): string {
	return getAgentExperiencePaths(env).root;
}

function assertContained(root: string, candidate: string): void {
	const relativePath = relative(root, candidate);
	if (relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))) return;
	throw new Error(`Path escapes Agent Experience private root: ${candidate}`);
}

function rejectUnsafeSegments(segments: string[]): void {
	for (const segment of segments) {
		if (!segment || segment.includes("\0") || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\")) {
			throw new Error(`Unsafe Agent Experience path segment: ${segment}`);
		}
	}
}

export function resolvePrivatePath(root: string, ...segments: string[]): string {
	rejectUnsafeSegments(segments);
	const resolvedRoot = resolve(root);
	const candidate = resolve(resolvedRoot, ...segments);
	assertContained(resolvedRoot, candidate);
	return candidate;
}

export async function ensurePrivateRoot(root = getPrivateStateRoot()): Promise<string> {
	const resolvedRoot = resolve(root);
	await mkdir(resolvedRoot, { recursive: true, mode: PRIVATE_DIR_MODE });
	const info = await lstat(resolvedRoot);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Agent Experience private root is not a real directory");
	await chmod(resolvedRoot, PRIVATE_DIR_MODE);
	return resolvedRoot;
}

export async function assertPathInsidePrivateRoot(root: string, candidate: string): Promise<void> {
	const lexicalRoot = resolve(root);
	const lexicalCandidate = resolve(candidate);
	assertContained(lexicalRoot, lexicalCandidate);
	const realRoot = await realpath(lexicalRoot);
	const realParent = await realpath(dirname(lexicalCandidate));
	assertContained(realRoot, realParent);
	try {
		const info = await lstat(lexicalCandidate);
		if (info.isSymbolicLink()) throw new Error(`Refusing symlinked Agent Experience path: ${lexicalCandidate}`);
	} catch (error: any) {
		if (error?.code !== "ENOENT") throw error;
	}
}

export async function openSensitiveFileForWrite(root: string, path: string, flags = constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY) {
	await ensurePrivateRoot(root);
	await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE });
	await chmod(dirname(path), PRIVATE_DIR_MODE);
	await assertPathInsidePrivateRoot(root, path);
	const nofollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const handle = await open(path, flags | nofollow, SENSITIVE_FILE_MODE);
	await chmod(path, SENSITIVE_FILE_MODE);
	return handle;
}

export async function chmodSensitiveFile(path: string): Promise<void> {
	await chmod(path, SENSITIVE_FILE_MODE);
}

export async function privateStatMode(path: string): Promise<number> {
	return (await stat(path)).mode & 0o777;
}

export async function copySensitiveFileWithinRoot(root: string, from: string, to: string): Promise<void> {
	await assertPathInsidePrivateRoot(root, from);
	await assertPathInsidePrivateRoot(root, to);
	await mkdir(dirname(to), { recursive: true, mode: PRIVATE_DIR_MODE });
	await copyFile(from, to);
	await chmod(to, SENSITIVE_FILE_MODE);
}
