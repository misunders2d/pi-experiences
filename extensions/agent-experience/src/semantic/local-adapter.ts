import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { getLocalEmbeddingAssetStatus } from "./local-model.ts";
import {
	LOCAL_EMBEDDING_DIMENSIONS,
	LOCAL_EMBEDDING_IDLE_MS,
	LOCAL_EMBEDDING_MAX_BATCH,
	LOCAL_EMBEDDING_MODEL,
	LOCAL_EMBEDDING_PROVIDER,
	LOCAL_EMBEDDING_TIMEOUT_MS,
} from "./local-model-manifest.ts";
import type { EmbeddingAdapter } from "./types.ts";

interface PendingRequest {
	resolve: (vectors: Float32Array[]) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	removeAbort?: () => void;
}

export interface LocalEmbeddingAdapter extends EmbeddingAdapter {
	close(): Promise<void>;
	isWorkerActive(): boolean;
}

export function resolveLocalEmbeddingWorkerUrl(moduleUrl = import.meta.url): URL {
	const candidates = [
		new URL("../../../../runtime/agent-experience/local-embedding-worker.mjs", moduleUrl),
		new URL("../runtime/agent-experience/local-embedding-worker.mjs", moduleUrl),
	];
	const worker = candidates.find((candidate) => existsSync(fileURLToPath(candidate)));
	if (!worker) throw new Error("Packaged local embedding worker is missing");
	return worker;
}

export function createLocalEmbeddingAdapter(root: string, options: { idleMs?: number; timeoutMs?: number; workerFactory?: (url: URL, options: any) => Worker } = {}): LocalEmbeddingAdapter {
	const idleMs = Math.max(100, Math.min(300_000, Math.trunc(options.idleMs ?? LOCAL_EMBEDDING_IDLE_MS)));
	const timeoutMs = Math.max(1_000, Math.min(300_000, Math.trunc(options.timeoutMs ?? LOCAL_EMBEDDING_TIMEOUT_MS)));
	const workerFactory = options.workerFactory || ((url: URL, workerOptions: any) => new Worker(url, workerOptions));
	let worker: Worker | undefined;
	let assetDir: string | undefined;
	let verified = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let terminating = false;
	const pending = new Map<string, PendingRequest>();

	function clearIdle() {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = undefined;
	}

	function rejectAll(error: Error) {
		for (const request of pending.values()) {
			clearTimeout(request.timer);
			request.removeAbort?.();
			request.reject(error);
		}
		pending.clear();
	}

	async function terminateWorker() {
		clearIdle();
		const current = worker;
		worker = undefined;
		if (!current) return;
		terminating = true;
		rejectAll(new Error("local_embedding_worker_terminated"));
		try { await current.terminate(); } finally { terminating = false; }
	}

	function armIdle() {
		clearIdle();
		if (pending.size || !worker) return;
		idleTimer = setTimeout(() => { void terminateWorker(); }, idleMs);
		idleTimer.unref?.();
	}

	async function ensureWorker(): Promise<Worker> {
		clearIdle();
		if (worker) return worker;
		if (!verified) {
			const status = await getLocalEmbeddingAssetStatus(root, { deep: true });
			if (!status.ready) throw new Error(`local_embedding_assets_unavailable:${status.reason}`);
			assetDir = status.assetDir;
			verified = true;
		}
		const created = workerFactory(resolveLocalEmbeddingWorkerUrl(), { workerData: { assetDir } });
		worker = created;
		created.on("message", (message: any) => {
			const request = pending.get(String(message?.id || ""));
			if (!request) return;
			pending.delete(String(message.id));
			clearTimeout(request.timer);
			request.removeAbort?.();
			if (!message.ok) request.reject(new Error(String(message.error || "local_embedding_worker_failed")));
			else {
				const vectors = Array.isArray(message.vectors) ? message.vectors.map((value: any) => value instanceof Float32Array ? value : new Float32Array(value)) : [];
				request.resolve(vectors);
			}
			armIdle();
		});
		created.on("error", (error) => {
			if (worker === created) worker = undefined;
			rejectAll(new Error(`local_embedding_worker_error:${String(error?.message || error)}`));
		});
		created.on("exit", (code) => {
			if (worker === created) worker = undefined;
			if (!terminating && code !== 0) rejectAll(new Error(`local_embedding_worker_exit:${code}`));
		});
		return created;
	}

	async function embed(texts: string[], input: { signal?: AbortSignal } = {}): Promise<Float32Array[]> {
		if (!Array.isArray(texts) || texts.length < 1 || texts.length > LOCAL_EMBEDDING_MAX_BATCH) throw new Error("Invalid local embedding batch");
		if (texts.some((text) => typeof text !== "string" || text.length < 1 || text.length > 5000)) throw new Error("Invalid local embedding text");
		if (input.signal?.aborted) throw input.signal.reason || new Error("local_embedding_aborted");
		const current = await ensureWorker();
		const id = randomUUID();
		return new Promise<Float32Array[]>((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				void terminateWorker();
				reject(new Error("local_embedding_timeout"));
			}, timeoutMs);
			const onAbort = () => {
				pending.delete(id);
				clearTimeout(timer);
				void terminateWorker();
				reject(input.signal?.reason instanceof Error ? input.signal.reason : new Error("local_embedding_aborted"));
			};
			if (input.signal) input.signal.addEventListener("abort", onAbort, { once: true });
			pending.set(id, { resolve, reject, timer, removeAbort: input.signal ? () => input.signal!.removeEventListener("abort", onAbort) : undefined });
			current.postMessage({ id, type: "embed", texts });
		});
	}

	return {
		id: `${LOCAL_EMBEDDING_PROVIDER}:${LOCAL_EMBEDDING_MODEL}:${LOCAL_EMBEDDING_DIMENSIONS}`,
		provider: LOCAL_EMBEDDING_PROVIDER,
		model: LOCAL_EMBEDDING_MODEL,
		dimensions: LOCAL_EMBEDDING_DIMENSIONS,
		embed,
		close: terminateWorker,
		isWorkerActive: () => !!worker,
	};
}
