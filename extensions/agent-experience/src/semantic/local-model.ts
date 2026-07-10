import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { canonicalJson, checksumJson } from "../storage/checksum.ts";
import { withOwnedLock } from "../storage/locks.ts";
import { chmodSensitiveFile, ensurePrivateRoot, openSensitiveFileForWrite, resolvePrivatePath, PRIVATE_DIR_MODE } from "../storage/private-root.ts";
import {
	LOCAL_EMBEDDING_ASSETS,
	LOCAL_EMBEDDING_ASSET_VERSION,
	LOCAL_EMBEDDING_DOWNLOAD_BYTES,
	LOCAL_EMBEDDING_MODEL,
	LOCAL_EMBEDDING_PROVIDER,
	LOCAL_EMBEDDING_REVISION,
	type LocalEmbeddingAssetDefinition,
} from "./local-model-manifest.ts";

const MODEL_LOCK = "embedding-model-download";
const MANIFEST_FILE = "manifest.json";

export interface LocalEmbeddingProgress {
	phase: "checking" | "downloading" | "verifying" | "ready" | "removing";
	asset?: string;
	asset_index?: number;
	asset_count?: number;
	downloaded_bytes: number;
	total_bytes: number;
}

interface AssetManifestBase {
	schema_version: 1;
	asset_version: string;
	provider: string;
	model: string;
	revision: string;
	created_at: string;
	total_bytes: number;
	license: "Apache-2.0 + MIT runtime";
	files: Array<{ name: string; bytes: number; sha256: string }>;
}

interface AssetManifest extends AssetManifestBase {
	manifest_checksum: string;
}

function manifestChecksum(base: AssetManifestBase): string {
	return checksumJson({ kind: "agent_experience_local_embedding_assets_v1", ...base });
}

function assetPaths(root: string) {
	const models = resolvePrivatePath(root, "models");
	const local = resolvePrivatePath(root, "models", "local-embedding");
	const version = resolvePrivatePath(root, "models", "local-embedding", LOCAL_EMBEDDING_ASSET_VERSION);
	return { models, local, version, manifest: resolvePrivatePath(root, "models", "local-embedding", LOCAL_EMBEDDING_ASSET_VERSION, MANIFEST_FILE) };
}

async function pathType(path: string): Promise<"file" | "directory" | null> {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink()) throw new Error(`Refusing symlinked local embedding path: ${path}`);
		if (info.isFile()) return "file";
		if (info.isDirectory()) return "directory";
		throw new Error(`Unsupported local embedding path: ${path}`);
	} catch (error: any) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

async function ensureDirectory(root: string, path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: PRIVATE_DIR_MODE });
	if (await pathType(path) !== "directory") throw new Error("Local embedding cache path is not a private directory");
}

function isTransientInstallName(name: string): boolean {
	return name.startsWith(".staging-") || name.startsWith(".invalid-");
}

function isCleanupCandidate(name: string): boolean {
	return name !== LOCAL_EMBEDDING_ASSET_VERSION && (isTransientInstallName(name) || /^multilingual-minilm-l12-int8-v\d+$/.test(name));
}

async function listManagedInstallArtifacts(localDir: string): Promise<string[]> {
	return readdir(localDir).catch((error: any) => error?.code === "ENOENT" ? [] : Promise.reject(error));
}

async function cleanupManagedInstallArtifacts(root: string, localDir: string, keep?: string): Promise<void> {
	for (const entry of await listManagedInstallArtifacts(localDir)) {
		if (entry !== keep && isCleanupCandidate(entry)) await rm(resolvePrivatePath(root, "models", "local-embedding", entry), { recursive: true, force: true });
	}
}

async function recoverInterruptedInstall(root: string, paths: ReturnType<typeof assetPaths>) {
	if (await pathType(paths.version) !== null) return undefined;
	const entries = await listManagedInstallArtifacts(paths.local);
	const candidates = [
		...entries.filter((entry) => entry.startsWith(".invalid-")).sort(),
		...entries.filter((entry) => entry.startsWith(".staging-")).sort(),
	];
	for (const entry of candidates) {
		const candidate = resolvePrivatePath(root, "models", "local-embedding", entry);
		let kind: "file" | "directory" | null;
		try { kind = await pathType(candidate); } catch {
			await rm(candidate, { recursive: true, force: true });
			continue;
		}
		if (kind !== "directory") {
			await rm(candidate, { recursive: true, force: true });
			continue;
		}
		await rename(candidate, paths.version);
		const recovered = await getLocalEmbeddingAssetStatus(root, { deep: true });
		if (recovered.ready) {
			await cleanupManagedInstallArtifacts(root, paths.local);
			return recovered;
		}
		await rm(paths.version, { recursive: true, force: true });
	}
	return undefined;
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

function parseManifest(text: string): AssetManifest {
	let manifest: AssetManifest;
	try { manifest = JSON.parse(text); } catch { throw new Error("Invalid local embedding asset manifest JSON"); }
	if (!manifest || manifest.schema_version !== 1 || manifest.asset_version !== LOCAL_EMBEDDING_ASSET_VERSION || manifest.provider !== LOCAL_EMBEDDING_PROVIDER || manifest.model !== LOCAL_EMBEDDING_MODEL || manifest.revision !== LOCAL_EMBEDDING_REVISION) throw new Error("Local embedding asset manifest version mismatch");
	const { manifest_checksum, ...base } = manifest;
	if (manifest_checksum !== manifestChecksum(base)) throw new Error("Local embedding asset manifest checksum mismatch");
	if (!Array.isArray(manifest.files) || manifest.total_bytes !== LOCAL_EMBEDDING_DOWNLOAD_BYTES) throw new Error("Local embedding asset manifest contents mismatch");
	return manifest;
}

export async function getLocalEmbeddingAssetStatus(root: string, options: { deep?: boolean } = {}) {
	const privateRoot = await ensurePrivateRoot(root);
	const paths = assetPaths(privateRoot);
	try {
		for (const parent of [paths.models, paths.local]) {
			const kind = await pathType(parent);
			if (kind !== null && kind !== "directory") throw new Error("Local embedding cache parent is not a private directory");
		}
		if (await pathType(paths.version) !== "directory" || await pathType(paths.manifest) !== "file") return { ready: false as const, reason: "missing", assetDir: paths.version, totalBytes: LOCAL_EMBEDDING_DOWNLOAD_BYTES };
		const expectedNames = [...LOCAL_EMBEDDING_ASSETS.map((asset) => asset.name), MANIFEST_FILE].sort();
		const actualNames = (await readdir(paths.version)).sort();
		if (canonicalJson(actualNames) !== canonicalJson(expectedNames)) throw new Error("Local embedding cache contains unexpected artifacts");
		const manifest = parseManifest(await readFile(paths.manifest, "utf8"));
		const expected = new Map(LOCAL_EMBEDDING_ASSETS.map((asset) => [asset.name, asset]));
		if (manifest.files.length !== expected.size) throw new Error("Local embedding asset file count mismatch");
		for (const file of manifest.files) {
			const definition = expected.get(file.name as LocalEmbeddingAssetDefinition["name"]);
			if (!definition || file.bytes !== definition.bytes || file.sha256 !== definition.sha256) throw new Error(`Local embedding asset metadata mismatch: ${file.name}`);
			const path = resolvePrivatePath(privateRoot, "models", "local-embedding", LOCAL_EMBEDDING_ASSET_VERSION, file.name);
			if (await pathType(path) !== "file") throw new Error(`Local embedding asset missing: ${file.name}`);
			if ((await stat(path)).size !== file.bytes) throw new Error(`Local embedding asset size mismatch: ${file.name}`);
			if (options.deep !== false && await hashFile(path) !== file.sha256) throw new Error(`Local embedding asset checksum mismatch: ${file.name}`);
		}
		return { ready: true as const, reason: "ready", assetDir: paths.version, totalBytes: manifest.total_bytes, manifest };
	} catch (error: any) {
		return { ready: false as const, reason: String(error?.message || error), assetDir: paths.version, totalBytes: LOCAL_EMBEDDING_DOWNLOAD_BYTES };
	}
}

async function downloadAsset(root: string, stagingDir: string, asset: LocalEmbeddingAssetDefinition, input: { fetchImpl: typeof fetch; signal?: AbortSignal; onProgress?: (progress: LocalEmbeddingProgress) => void; downloadedBefore: number; index: number }) {
	if (input.signal?.aborted) throw input.signal.reason || new Error("local_embedding_download_aborted");
	const timeoutSignal = AbortSignal.timeout(10 * 60_000);
	const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
	const response = await input.fetchImpl(asset.url, { signal, redirect: "follow" });
	if (!response.ok || !response.body) throw new Error(`Local embedding asset download failed: ${asset.name} (${response.status})`);
	const target = resolvePrivatePath(root, "models", "local-embedding", basenameSegment(stagingDir), asset.name);
	const handle = await openSensitiveFileForWrite(root, target);
	const hash = createHash("sha256");
	let bytes = 0;
	try {
		for await (const raw of response.body as any) {
			if (signal.aborted) throw signal.reason || new Error("local_embedding_download_aborted");
			const chunk = Buffer.from(raw);
			bytes += chunk.length;
			if (bytes > asset.bytes) throw new Error(`Local embedding asset exceeds byte cap: ${asset.name}`);
			hash.update(chunk);
			await handle.write(chunk);
			input.onProgress?.({ phase: "downloading", asset: asset.name, asset_index: input.index + 1, asset_count: LOCAL_EMBEDDING_ASSETS.length, downloaded_bytes: input.downloadedBefore + bytes, total_bytes: LOCAL_EMBEDDING_DOWNLOAD_BYTES });
		}
		await handle.sync();
	} finally {
		await handle.close();
	}
	if (bytes !== asset.bytes) throw new Error(`Local embedding asset size mismatch: ${asset.name}`);
	if (hash.digest("hex") !== asset.sha256) throw new Error(`Local embedding asset checksum mismatch: ${asset.name}`);
	await chmodSensitiveFile(target);
}

function basenameSegment(path: string): string {
	const segment = path.split(/[\\/]/).at(-1) || "";
	if (!/^[A-Za-z0-9._-]+$/.test(segment)) throw new Error("Invalid local embedding staging path");
	return segment;
}

async function writeManifest(root: string, stagingName: string, createdAt: string): Promise<AssetManifest> {
	const base: AssetManifestBase = {
		schema_version: 1,
		asset_version: LOCAL_EMBEDDING_ASSET_VERSION,
		provider: LOCAL_EMBEDDING_PROVIDER,
		model: LOCAL_EMBEDDING_MODEL,
		revision: LOCAL_EMBEDDING_REVISION,
		created_at: createdAt,
		total_bytes: LOCAL_EMBEDDING_DOWNLOAD_BYTES,
		license: "Apache-2.0 + MIT runtime",
		files: LOCAL_EMBEDDING_ASSETS.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
	};
	const manifest = { ...base, manifest_checksum: manifestChecksum(base) };
	const path = resolvePrivatePath(root, "models", "local-embedding", stagingName, MANIFEST_FILE);
	const handle = await openSensitiveFileForWrite(root, path);
	try { await handle.writeFile(canonicalJson(manifest), "utf8"); await handle.sync(); } finally { await handle.close(); }
	return manifest;
}

export async function ensureLocalEmbeddingAssets(root: string, input: { signal?: AbortSignal; onProgress?: (progress: LocalEmbeddingProgress) => void; fetchImpl?: typeof fetch; createdAt?: string } = {}) {
	const privateRoot = await ensurePrivateRoot(root);
	input.onProgress?.({ phase: "checking", downloaded_bytes: 0, total_bytes: LOCAL_EMBEDDING_DOWNLOAD_BYTES });
	const existing = await getLocalEmbeddingAssetStatus(privateRoot, { deep: true });
	const pathsBeforeLock = assetPaths(privateRoot);
	const cleanupNeeded = (await listManagedInstallArtifacts(pathsBeforeLock.local)).some(isCleanupCandidate);
	if (existing.ready && !cleanupNeeded) return existing;
	return withOwnedLock(privateRoot, MODEL_LOCK, async () => {
		const paths = assetPaths(privateRoot);
		await ensureDirectory(privateRoot, paths.models);
		await ensureDirectory(privateRoot, paths.local);
		const recovered = await recoverInterruptedInstall(privateRoot, paths);
		if (recovered?.ready) return recovered;
		const afterLock = await getLocalEmbeddingAssetStatus(privateRoot, { deep: true });
		await cleanupManagedInstallArtifacts(privateRoot, paths.local);
		if (afterLock.ready) return afterLock;
		const stagingName = `.staging-${randomUUID()}`;
		const stagingDir = resolvePrivatePath(privateRoot, "models", "local-embedding", stagingName);
		await mkdir(stagingDir, { mode: PRIVATE_DIR_MODE });
		let invalidDir: string | undefined;
		try {
			let downloaded = 0;
			for (let index = 0; index < LOCAL_EMBEDDING_ASSETS.length; index += 1) {
				const asset = LOCAL_EMBEDDING_ASSETS[index];
				await downloadAsset(privateRoot, stagingDir, asset, { fetchImpl: input.fetchImpl || fetch, signal: input.signal, onProgress: input.onProgress, downloadedBefore: downloaded, index });
				downloaded += asset.bytes;
			}
			input.onProgress?.({ phase: "verifying", downloaded_bytes: downloaded, total_bytes: LOCAL_EMBEDDING_DOWNLOAD_BYTES });
			await writeManifest(privateRoot, stagingName, input.createdAt || new Date().toISOString());
			if (await pathType(paths.version)) {
				invalidDir = resolvePrivatePath(privateRoot, "models", "local-embedding", `.invalid-${randomUUID()}`);
				await rename(paths.version, invalidDir);
			}
			await rename(stagingDir, paths.version);
			const ready = await getLocalEmbeddingAssetStatus(privateRoot, { deep: true });
			if (!ready.ready) throw new Error(ready.reason);
			if (invalidDir) await rm(invalidDir, { recursive: true, force: true });
			await cleanupManagedInstallArtifacts(privateRoot, paths.local);
			input.onProgress?.({ phase: "ready", downloaded_bytes: LOCAL_EMBEDDING_DOWNLOAD_BYTES, total_bytes: LOCAL_EMBEDDING_DOWNLOAD_BYTES });
			return ready;
		} catch (error) {
			await rm(stagingDir, { recursive: true, force: true });
			if (invalidDir && !(await pathType(paths.version))) await rename(invalidDir, paths.version).catch(() => undefined);
			throw error;
		}
	}, { waitMs: 120_000 });
}

export async function removeLocalEmbeddingAssets(root: string, input: { onProgress?: (progress: LocalEmbeddingProgress) => void } = {}) {
	const privateRoot = await ensurePrivateRoot(root);
	return withOwnedLock(privateRoot, MODEL_LOCK, async () => {
		input.onProgress?.({ phase: "removing", downloaded_bytes: 0, total_bytes: LOCAL_EMBEDDING_DOWNLOAD_BYTES });
		const paths = assetPaths(privateRoot);
		const localKind = await pathType(paths.local);
		if (localKind !== null && localKind !== "directory") throw new Error("Local embedding cache parent is not a private directory");
		if (localKind === "directory") {
			for (const entry of await readdir(paths.local)) {
				if (entry.startsWith(".staging-") || entry.startsWith(".invalid-") || /^multilingual-minilm-l12-int8-v\d+$/.test(entry)) await rm(resolvePrivatePath(privateRoot, "models", "local-embedding", entry), { recursive: true, force: true });
			}
		}
		return { removed: true, assetDir: paths.version };
	}, { waitMs: 10_000 });
}
