import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { createGrepTool, createReadTool } from "@earendil-works/pi-coding-agent";
import { glob as nodeGlob, open, realpath, type FileHandle } from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";
import { Type } from "typebox";
import { getPrivateStateRoot } from "../storage/private-root.ts";
import { containsUnredactedSensitiveText, redactJson, redactText } from "../storage/redaction.ts";

const MAX_INVESTIGATIVE_CALLS = 3;
const MAX_RESULT_CHARS = 8_000;
const MAX_AGGREGATE_RESULT_CHARS = 16_000;
const MAX_GLOB_MATCHES = 100;
const MAX_GREP_FILES = 1_000;
const MAX_FILE_INPUT_BYTES = 256 * 1_024;
const MAX_GREP_INPUT_BYTES = 1_024 * 1_024;
const ACCESS_DENIED = "Advisor workspace access denied.";
const NOT_A_FILE = "Advisor workspace path is not a file.";
const RESULT_DENIED = "Advisor workspace result denied.";
const BUDGET_EXHAUSTED = "Advisor investigative tool budget exhausted.";

const GREP_ABORTED = "Advisor grep aborted.";

const REGEX_MATCHER_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
let matcher;
try {
	matcher = new RegExp(workerData.source, workerData.flags);
	parentPort.postMessage({ type: "ready" });
} catch {
	parentPort.postMessage({ type: "error" });
}
if (matcher) {
	parentPort.on("message", ({ id, text, limit }) => {
		const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
		const matches = [];
		for (let index = 0; index < lines.length && matches.length < limit; index++) {
			matcher.lastIndex = 0;
			if (matcher.test(lines[index])) matches.push({ lineNumber: index + 1, line: lines[index] });
		}
		parentPort.postMessage({ type: "matches", id, matches });
	});
}
`;
const GlobParameters = Type.Object({
	pattern: Type.String({ minLength: 1, maxLength: 500 }),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_GLOB_MATCHES })),
}, { additionalProperties: false });

export interface AdvisorWorkspaceBudget {
	calls: number;
	resultChars: number;
}

export interface AdvisorWorkspaceToolOptions {
	afterPathValidation?: (tool: "read" | "grep", requestedPath: string, canonicalPath: string) => Promise<void> | void;
}

export function createAdvisorWorkspaceBudget(): AdvisorWorkspaceBudget {
	return { calls: 0, resultChars: 0 };
}

function denied(): never {
	throw new Error(ACCESS_DENIED);
}

function canonicalIfPresent(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function isContained(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}


function requestedSegments(value: string): string[] {
	if (typeof value !== "string" || !value || value.includes("\0")) denied();
	const portable = value.replaceAll("\\", "/");
	if (isAbsolute(value) || /^[A-Za-z]:\//.test(portable) || portable.startsWith("~")) denied();
	const segments = portable.split("/").filter((segment) => segment !== "" && segment !== ".");
	if (segments.includes("..")) denied();
	return segments;
}

function isDeniedSegment(segment: string): boolean {
	const lower = segment.toLowerCase();
	if (lower === ".git" || lower === ".hg" || lower === ".svn") return true;
	if (lower === ".ssh" || lower === ".gnupg" || lower === ".aws" || lower === ".azure" || lower === ".kube" || lower === ".docker" || lower === ".terraform.d") return true;
	if (lower === ".npmrc" || lower === ".pypirc" || lower === ".netrc" || lower === "auth.json") return true;
	if (lower === "credentials" || lower === "credentials.json" || lower === "secrets" || lower === "secrets.json") return true;
	if (lower === "id_rsa" || lower === "id_ed25519") return true;
	if (/^\.env(?:\..*)?$/.test(lower)) return true;
	if (/\.(?:pem|key|p12|pfx|crt|cer)$/.test(lower)) return true;
	return false;
}

function hasDeniedPath(segments: string[]): boolean {
	if (segments.some(isDeniedSegment)) return true;
	const portable = segments.map((segment) => segment.toLowerCase()).join("/");
	if (/(?:^|\/)\.config\/(?:gcloud|gh|op|1password|containers)(?:\/|$)/.test(portable)) return true;
	if (/(?:^|\/)\.local\/share\/keyrings(?:\/|$)/.test(portable)) return true;
	return false;
}

function validateRequestedPath(value: string): void {
	const segments = requestedSegments(value);
	if (hasDeniedPath(segments)) denied();
}

function validateRequestedGlob(value: string): void {
	const segments = requestedSegments(value);
	if (hasDeniedPath(segments)) denied();
	for (const segment of segments) {
		const lower = segment.toLowerCase();
		if (/^\.env(?:[.*?{[].*)?$/.test(lower)) denied();
		if (/\.(?:pem|key|p12|pfx|crt|cer)(?:[*$?}\]].*)?$/.test(lower)) denied();
		if (/^(?:\.git|\.hg|\.svn)(?:[*$?{[].*)?$/.test(lower)) denied();
	}
}

function assertCandidateSafe(root: string, stateRoot: string, candidate: string): void {
	if (!isContained(root, candidate)) denied();
	const relativeCandidate = relative(root, candidate);
	const segments = relativeCandidate.split(sep).filter(Boolean);
	if (hasDeniedPath(segments)) denied();
	if (isContained(stateRoot, candidate)) denied();
}

async function validateExistingPath(root: string, stateRoot: string, requested: string): Promise<string> {
	validateRequestedPath(requested);
	try {
		const candidate = await realpath(resolve(root, requested));
		assertCandidateSafe(root, stateRoot, candidate);
		return candidate;
	} catch (error) {
		if (error instanceof Error && error.message === ACCESS_DENIED) throw error;
		denied();
	}
}

interface ConfinedOpenPath {
	handle: FileHandle;
	descriptorPath: string;
	isFile: boolean;
	isDirectory: boolean;
	size: number;
}

async function openConfinedPath(root: string, stateRoot: string, absolutePath: string): Promise<ConfinedOpenPath> {
	let handle: FileHandle | undefined;
	try {
		const canonical = await realpath(absolutePath);
		assertCandidateSafe(root, stateRoot, canonical);
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		handle = await open(canonical, constants.O_RDONLY | noFollow);
		let descriptorPath = "";
		for (const candidate of [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`]) {
			try {
				const openedCanonical = await realpath(candidate);
				assertCandidateSafe(root, stateRoot, openedCanonical);
				descriptorPath = candidate;
				break;
			} catch {
				continue;
			}
		}
		if (!descriptorPath) denied();
		const info = await handle.stat();
		if (!Number.isSafeInteger(info.size) || info.size < 0) denied();
		return { handle, descriptorPath, isFile: info.isFile(), isDirectory: info.isDirectory(), size: info.size };
	} catch (error) {
		await handle?.close().catch(() => undefined);
		if (error instanceof Error && error.message === ACCESS_DENIED) throw error;
		denied();
	}
}

async function readBoundedOpenFile(opened: ConfinedOpenPath, maxBytes = MAX_FILE_INPUT_BYTES): Promise<Buffer> {
	if (!opened.isFile) throw new Error(NOT_A_FILE);
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || opened.size > maxBytes) denied();
	const buffer = Buffer.alloc(opened.size);
	const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, 0);
	return buffer.subarray(0, bytesRead);
}

async function readConfinedFile(root: string, stateRoot: string, absolutePath: string, maxBytes = MAX_FILE_INPUT_BYTES): Promise<Buffer> {
	const opened = await openConfinedPath(root, stateRoot, absolutePath);
	try {
		return await readBoundedOpenFile(opened, maxBytes);
	} finally {
		await opened.handle.close();
	}
}

interface RegexLineMatch {
	lineNumber: number;
	line: string;
}

interface TerminableRegexMatcher {
	match(text: string, limit: number): Promise<RegexLineMatch[]>;
	close(): Promise<void>;
}

async function createTerminableRegexMatcher(
	source: string,
	flags: string,
	signal?: AbortSignal,
): Promise<TerminableRegexMatcher> {
	const worker = new Worker(REGEX_MATCHER_WORKER_SOURCE, {
		eval: true,
		workerData: { source, flags },
	});
	let closed = false;
	let failure: Error | undefined;
	let nextId = 0;
	let pending: {
		id: number;
		resolve: (matches: RegexLineMatch[]) => void;
		reject: (error: Error) => void;
	} | undefined;
	let resolveReady!: () => void;
	let rejectReady!: (error: Error) => void;
	let termination: Promise<number> | undefined;
	const ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	const terminate = () => {
		termination ??= worker.terminate();
		return termination;
	};
	const fail = (error: Error) => {
		if (failure || closed) return;
		failure = error;
		rejectReady(error);
		pending?.reject(error);
		pending = undefined;
	};
	const abort = () => {
		fail(new Error(GREP_ABORTED));
		void terminate();
	};

	worker.on("message", (message: unknown) => {
		if (!message || typeof message !== "object" || !("type" in message)) {
			fail(new Error(ACCESS_DENIED));
			void terminate();
			return;
		}
		if (message.type === "ready") {
			resolveReady();
			return;
		}
		if (message.type === "error") {
			fail(new Error(ACCESS_DENIED));
			void terminate();
			return;
		}
		if (!pending || message.type !== "matches" || !("id" in message) || !("matches" in message) || message.id !== pending.id || !Array.isArray(message.matches)) {
			fail(new Error(ACCESS_DENIED));
			void terminate();
			return;
		}
		const matches: RegexLineMatch[] = [];
		for (const match of message.matches) {
			if (!match || typeof match !== "object" || !("lineNumber" in match) || !("line" in match)
				|| !Number.isInteger(match.lineNumber) || match.lineNumber < 1 || typeof match.line !== "string") {
				fail(new Error(ACCESS_DENIED));
				void terminate();
				return;
			}
			matches.push({ lineNumber: match.lineNumber, line: match.line });
		}
		const current = pending;
		pending = undefined;
		current.resolve(matches);
	});
	worker.on("error", () => fail(new Error(ACCESS_DENIED)));
	worker.on("exit", () => {
		if (!closed) fail(failure ?? new Error(ACCESS_DENIED));
	});
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });

	try {
		await ready;
	} catch (error) {
		signal?.removeEventListener("abort", abort);
		await terminate().catch(() => undefined);
		throw error;
	}

	return {
		match(text, limit) {
			if (failure) return Promise.reject(failure);
			if (closed || pending || !Number.isInteger(limit) || limit < 1) return Promise.reject(new Error(ACCESS_DENIED));
			return new Promise<RegexLineMatch[]>((resolve, reject) => {
				const id = nextId++;
				pending = { id, resolve, reject };
				try {
					worker.postMessage({ id, text, limit });
				} catch {
					fail(new Error(ACCESS_DENIED));
				}
			});
		},
		async close() {
			if (closed) return;
			closed = true;
			signal?.removeEventListener("abort", abort);
			pending?.reject(failure ?? new Error(GREP_ABORTED));
			pending = undefined;
			await terminate().catch(() => undefined);
		},
	};
}

function consumeCall(budget: AdvisorWorkspaceBudget): void {
	if (!Number.isInteger(budget.calls) || !Number.isInteger(budget.resultChars) || budget.calls < 0 || budget.resultChars < 0) {
		throw new Error(BUDGET_EXHAUSTED);
	}
	if (budget.calls >= MAX_INVESTIGATIVE_CALLS) throw new Error(BUDGET_EXHAUSTED);
	budget.calls++;
}

function fitSafeResult(text: string, details: unknown, budget: AdvisorWorkspaceBudget): AgentToolResult<unknown> {
	const remaining = Math.max(0, MAX_AGGREGATE_RESULT_CHARS - budget.resultChars);
	const limit = Math.min(MAX_RESULT_CHARS, remaining);
	if (limit === 0) return { content: [], details: undefined };

	let boundedDetails = details ?? {};
	let detailsChars = JSON.stringify(boundedDetails).length;
	if (detailsChars > limit) {
		boundedDetails = { truncated: true };
		detailsChars = JSON.stringify(boundedDetails).length;
	}
	const boundedText = text.slice(0, Math.max(0, limit - detailsChars));
	budget.resultChars += boundedText.length + detailsChars;
	return {
		content: boundedText ? [{ type: "text", text: boundedText }] : [],
		details: boundedDetails,
	};
}

function staticResultDenial(budget: AdvisorWorkspaceBudget): AgentToolResult<unknown> {
	return fitSafeResult(RESULT_DENIED, undefined, budget);
}

function sanitizeResult(result: unknown, budget: AdvisorWorkspaceBudget): AgentToolResult<unknown> {
	try {
		if (!result || typeof result !== "object" || !(("content") in result)) return staticResultDenial(budget);
		const content = result.content;
		if (!Array.isArray(content)) return staticResultDenial(budget);
		const texts: string[] = [];
		for (const part of content) {
			if (!part || typeof part !== "object" || !(("type") in part) || part.type !== "text" || !(("text") in part) || typeof part.text !== "string") {
				return staticResultDenial(budget);
			}
			texts.push(part.text);
		}
		const text = redactText(texts.join("\n"));
		const details = redactJson(("details" in result) ? result.details : undefined);
		if (containsUnredactedSensitiveText(text) || containsUnredactedSensitiveText(details)) return staticResultDenial(budget);
		JSON.stringify(details);
		return fitSafeResult(text, details, budget);
	} catch {
		return staticResultDenial(budget);
	}
}

function wrapTool(
	base: AgentTool,
	budget: AdvisorWorkspaceBudget,
	transform: (params: Record<string, unknown>) => Promise<Record<string, unknown>>,
): AgentTool {
	return {
		...base,
		executionMode: "sequential",
		async execute(toolCallId, params, signal) {
			consumeCall(budget);
			try {
				const safeParams = await transform(params);
				const result = await base.execute(toolCallId, safeParams, signal);
				return sanitizeResult(result, budget);
			} catch (error) {
				const message = error instanceof Error ? error.message : "";
				if (message === ACCESS_DENIED || message === BUDGET_EXHAUSTED) throw error;
				throw new Error(ACCESS_DENIED);
			}
		},
	};
}

export function createAdvisorWorkspaceTools(
	cwd: string,
	budget: AdvisorWorkspaceBudget,
	options: AdvisorWorkspaceToolOptions = {},
): AgentTool[] {
	const root = realpathSync(resolve(cwd));
	const stateRoot = canonicalIfPresent(getPrivateStateRoot());
	const readBase = createReadTool(root, {
		operations: {
			async access(absolutePath) {
				const opened = await openConfinedPath(root, stateRoot, absolutePath);
				try {
					if (!opened.isFile) denied();
				} finally {
					await opened.handle.close();
				}
			},
			readFile: (absolutePath) => readConfinedFile(root, stateRoot, absolutePath),
		},
	});
	const read = wrapTool(readBase, budget, async (params) => {
		const requestedPath = String(params.path ?? "");
		const canonicalPath = await validateExistingPath(root, stateRoot, requestedPath);
		await options.afterPathValidation?.("read", requestedPath, canonicalPath);
		return { ...params, path: canonicalPath };
	});

	const grepBase = createGrepTool(root);
	const grep: AgentTool = {
		...grepBase,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			consumeCall(budget);
			let openedSearch: ConfinedOpenPath | undefined;
			let regexMatcher: TerminableRegexMatcher | undefined;
			try {
				const requestedPath = typeof params.path === "string" ? params.path : ".";
				const canonicalPath = await validateExistingPath(root, stateRoot, requestedPath);
				if (typeof params.glob === "string") validateRequestedGlob(params.glob);
				await options.afterPathValidation?.("grep", requestedPath, canonicalPath);
				openedSearch = await openConfinedPath(root, stateRoot, canonicalPath);

				const rawPattern = String(params.pattern ?? "");
				const escapedPattern = rawPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				regexMatcher = await createTerminableRegexMatcher(
					params.literal === true ? escapedPattern : rawPattern,
					params.ignoreCase === true ? "i" : "",
					signal,
				);
				const matchLimit = Math.min(Math.max(1, Number.isInteger(params.limit) ? params.limit : 100), 100);
				const contextLines = Math.min(Math.max(0, Number.isInteger(params.context) ? params.context : 0), 20);
				const candidates: Array<{ absolutePath: string; label: string; content?: Buffer }> = [];

				if (openedSearch.isFile) {
					candidates.push({
						absolutePath: canonicalPath,
						label: relative(root, canonicalPath).split(sep).join("/"),
						content: await readBoundedOpenFile(openedSearch, Math.min(MAX_FILE_INPUT_BYTES, MAX_GREP_INPUT_BYTES)),
					});
				} else if (openedSearch.isDirectory) {
					const filePattern = typeof params.glob === "string" ? params.glob : "**/*";
					for await (const entry of nodeGlob(filePattern, { cwd: openedSearch.descriptorPath })) {
						if (signal?.aborted) throw new Error(GREP_ABORTED);
						if (candidates.length >= MAX_GREP_FILES) break;
						const absolutePath = resolve(openedSearch.descriptorPath, String(entry));
						try {
							const canonicalCandidate = await realpath(absolutePath);
							assertCandidateSafe(root, stateRoot, canonicalCandidate);
							if (!isContained(canonicalPath, canonicalCandidate)) continue;
							candidates.push({
								absolutePath,
								label: relative(root, canonicalCandidate).split(sep).join("/"),
							});
						} catch {
							continue;
						}
					}
				} else {
					denied();
				}

				const output: string[] = [];
				let matches = 0;
				let scannedBytes = 0;
				for (const candidate of candidates) {
					if (matches >= matchLimit) break;
					if (signal?.aborted) throw new Error(GREP_ABORTED);
					const remainingBytes = MAX_GREP_INPUT_BYTES - scannedBytes;
					if (remainingBytes <= 0) denied();
					let content: Buffer;
					try {
						content = candidate.content ?? await readConfinedFile(root, stateRoot, candidate.absolutePath, Math.min(MAX_FILE_INPUT_BYTES, remainingBytes));
					} catch (error) {
						if (error instanceof Error && error.message === ACCESS_DENIED) throw error;
						if (error instanceof Error && error.message === NOT_A_FILE) continue;
						continue;
					}
					if (content.length > remainingBytes) denied();
					scannedBytes += content.length;
					const text = content.toString("utf8");
					const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
					const fileMatches = await regexMatcher.match(text, matchLimit - matches);
					for (const match of fileMatches) {
						matches++;
						const index = match.lineNumber - 1;
						const start = Math.max(0, index - contextLines);
						const end = Math.min(lines.length - 1, index + contextLines);
						for (let current = start; current <= end; current++) {
							const separator = current === index ? ":" : "-";
							output.push(`${candidate.label}${separator}${current + 1}${separator} ${lines[current]}`);
						}
					}
				}
				return sanitizeResult({
					content: [{ type: "text", text: output.length ? output.join("\n") : "No matches found" }],
					details: matches >= matchLimit ? { matchLimitReached: matchLimit } : undefined,
				}, budget);
			} catch (error) {
				const message = error instanceof Error ? error.message : "";
				if (message === ACCESS_DENIED || message === BUDGET_EXHAUSTED || message === GREP_ABORTED) throw error;
				throw new Error(ACCESS_DENIED);
			} finally {
				await regexMatcher?.close();
				await openedSearch?.handle.close().catch(() => undefined);
			}
		},
	};

	const glob: AgentTool<typeof GlobParameters> = {
		name: "glob",
		label: "Glob",
		description: "List at most 100 workspace-confined paths matching a safe relative glob.",
		parameters: GlobParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			consumeCall(budget);
			validateRequestedGlob(params.pattern);
			const explicit = !/[*?\[\]{}()!]/.test(params.pattern);
			const limit = Math.min(params.limit ?? MAX_GLOB_MATCHES, MAX_GLOB_MATCHES);
			const matches: string[] = [];
			try {
				for await (const entry of nodeGlob(params.pattern, { cwd: root })) {
					if (signal?.aborted) throw new Error(BUDGET_EXHAUSTED);
					try {
						const canonical = await realpath(resolve(root, String(entry)));
						assertCandidateSafe(root, stateRoot, canonical);
						matches.push(relative(root, canonical).split(sep).join("/"));
					} catch (error) {
						if (explicit) throw error;
						continue;
					}
					if (matches.length >= limit) break;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : "";
				if (message === BUDGET_EXHAUSTED) throw error;
				throw new Error(ACCESS_DENIED);
			}
			matches.sort();
			return sanitizeResult({
				content: [{ type: "text", text: matches.join("\n") }],
				details: { matchCount: matches.length, truncated: matches.length === limit },
			}, budget);
		},
	};
	return [read, grep, glob];
}
