import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentExperienceConfig } from "../config.ts";
import { buildExperienceContextPack, revalidateExperienceCandidate, type ExperienceRetrievalCandidate } from "../experience/retrieval.ts";
import { retrieveApprovedHostExperienceContext, type HostExperienceContextInput } from "./context.ts";
import { appendUniqueObservation } from "../storage/observations.ts";
import { redactText } from "../storage/redaction.ts";

export const OMP_EXPERIENCE_CONTEXT_MARKER = "Agent Experience context v1";

const MAX_OMP_ADVISOR_QUERY_MESSAGES = 16;
const MAX_OMP_ADVISOR_QUERY_CHARS = 24_000;
const MAX_OMP_ADVISOR_VALUE_ITEMS = 16;
const MAX_OMP_ADVISOR_VALUE_KEYS = 24;
const MAX_OMP_ADVISOR_VALUE_KEY_CHARS = 256;
const MAX_OMP_ADVISOR_VALUE_CHARS = 2_000;
const MAX_OMP_ADVISOR_QUERY_NODES = 512;
const MAX_OMP_ADVISOR_QUERY_VALUE_CHARS = 20_000;
const MAX_OMP_ADVISOR_TRANSCRIPT_BYTES = 256 * 1024;
const MAX_OMP_ADVISOR_FINDINGS_PER_SCAN = 16;
const OMP_ADVISOR_TRANSCRIPT = /^__advisor(?:\.[a-z0-9-]+)?\.jsonl$/;

type OmpTranscriptFinding = {
	severity: "concern" | "blocker";
	attribution: string;
	eventFingerprint: string;
	createdAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
	return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function messageText(message: Record<string, unknown>): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.filter(isTextPart).map(item => item.text).join("\n");
}

function markedAttributions(
	text: string,
	allowedAttributions: ReadonlyMap<string, ExperienceRetrievalCandidate>,
): Set<string> {
	const markerPrefix = `[${OMP_EXPERIENCE_CONTEXT_MARKER} nonce=`;
	const markerLine = text.split("\n").find(line => line.startsWith(markerPrefix) && line.endsWith("]"));
	if (!markerLine) return new Set();
	const nonce = markerLine.slice(markerPrefix.length, -1);
	if (!/^[0-9a-f-]{36}$/.test(nonce)) return new Set();
	const jsonLine = text.slice(text.indexOf(markerLine) + markerLine.length).split("\n").find(line => line.trim().startsWith("{"));
	if (!jsonLine) return new Set();
	try {
		const payload: unknown = JSON.parse(jsonLine);
		if (!isRecord(payload) || !Array.isArray(payload.experienceContext)) return new Set();
		const keys = new Set<string>();
		for (const item of payload.experienceContext) {
			if (!isRecord(item) || item.kind !== "habit" || typeof item.alias !== "string") continue;
			const key = `${nonce}:${item.alias}`;
			if (allowedAttributions.has(key)) keys.add(key);
		}
		return keys;
	} catch {
		return new Set();
	}
}

export function extractOmpAdvisorTranscriptFindings(
	jsonl: string,
	now: string,
	allowedAttributions: ReadonlyMap<string, ExperienceRetrievalCandidate>,
): OmpTranscriptFinding[] {
	const findings: OmpTranscriptFinding[] = [];
	let activeAttributions = new Set<string>();
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		let entry: unknown;
		try { entry = JSON.parse(line); } catch { continue; }
		if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
		const message = entry.message;
		if (message.role === "user") {
			activeAttributions = markedAttributions(messageText(message), allowedAttributions);
			continue;
		}
		if (!activeAttributions.size || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const advise = message.content.find(item => {
			if (!isRecord(item) || item.type !== "toolCall" || item.name !== "advise" || !isRecord(item.arguments)) return false;
			return typeof item.arguments.attribution === "string" && activeAttributions.has(item.arguments.attribution);
		});
		if (!isRecord(advise) || !isRecord(advise.arguments)) continue;
		const severity = advise.arguments.severity;
		const note = advise.arguments.note;
		const attribution = advise.arguments.attribution;
		if ((severity !== "concern" && severity !== "blocker") || typeof note !== "string" || !note.trim() || typeof attribution !== "string") continue;
		const eventFingerprint = createHash("sha256")
			.update(`omp_experience_advisor_v1:${attribution}:${severity}:${note}`)
			.digest("hex");
		findings.push({ severity, attribution, eventFingerprint, createdAt: now });
		activeAttributions = new Set();
		if (findings.length >= MAX_OMP_ADVISOR_FINDINGS_PER_SCAN) break;
	}
	return findings;
}

async function readTranscriptTail(path: string): Promise<string> {
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink()) return "";
	const length = Math.min(info.size, MAX_OMP_ADVISOR_TRANSCRIPT_BYTES);
	const offset = info.size - length;
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, offset);
		const text = buffer.toString("utf8");
		if (offset === 0) return text;
		const firstNewline = text.indexOf("\n");
		return firstNewline < 0 ? "" : text.slice(firstNewline + 1);
	} finally {
		await handle.close();
	}
}

export async function retainOmpAdvisorTranscriptFindings(input: {
	root: string;
	db: DatabaseSync;
	config: AgentExperienceConfig;
	userId: string;
	sessionFile: string;
	attributions: ReadonlyMap<string, ExperienceRetrievalCandidate>;
	now?: string;
}): Promise<{ appended: number }> {
	const sessionDir = input.sessionFile.endsWith(".jsonl") ? input.sessionFile.slice(0, -".jsonl".length) : dirname(input.sessionFile);
	const names = (await readdir(sessionDir)).filter(name => OMP_ADVISOR_TRANSCRIPT.test(name)).sort();
	let appended = 0;
	const now = input.now ?? new Date().toISOString();
	for (const name of names) {
		const findings = extractOmpAdvisorTranscriptFindings(
			await readTranscriptTail(join(sessionDir, name)),
			now,
			input.attributions,
		);
		for (const finding of findings) {
			const candidate = input.attributions.get(finding.attribution);
			if (!candidate) continue;
			let approvedBehavior: string;
			try {
				const current = revalidateExperienceCandidate(input.db, {
					userId: input.userId,
					now,
					alias: candidate.alias,
					candidates: [candidate],
					config: input.config,
				});
				approvedBehavior = redactText(current.content.trim()).slice(0, 1_000);
			} catch {
				continue;
			}
			const payload = {
				kind: "advisor_finding_v1",
				finding_kind: "habit_violation",
				severity: finding.severity,
				primary_behavior_redacted: "[OMP native Advisor attributed advice to one approved Experience]",
				approved_behavior_redacted: approvedBehavior,
				event_fingerprint: finding.eventFingerprint,
				primary_created_at: finding.createdAt,
			};
			const result = await appendUniqueObservation(input.root, {
				userId: input.userId,
				origin: { source: "advisor_finding" },
				payload,
				id: `advisor-${createHash("sha256").update(`advisor_finding_v1:${finding.eventFingerprint}`).digest("hex")}`,
				createdAt: finding.createdAt,
				eventFingerprint: finding.eventFingerprint,
			});
			if (result.appended) appended++;
		}
	}
	return { appended };
}

type OmpQueryBudget = { nodes: number; chars: number; seen: Set<object> };

function boundedOmpAdvisorValue(value: unknown, budget: OmpQueryBudget, depth = 0): unknown {
	if (budget.nodes <= 0 || budget.chars <= 0) return undefined;
	budget.nodes--;
	if (typeof value === "string") {
		const length = Math.min(value.length, MAX_OMP_ADVISOR_VALUE_CHARS, budget.chars);
		budget.chars -= length;
		return value.slice(-length);
	}
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (depth >= 4 || !value || typeof value !== "object" || budget.seen.has(value)) return undefined;
	budget.seen.add(value);
	if (Array.isArray(value)) {
		const bounded: unknown[] = [];
		for (const item of value.slice(-MAX_OMP_ADVISOR_VALUE_ITEMS)) {
			const next = boundedOmpAdvisorValue(item, budget, depth + 1);
			if (next !== undefined) bounded.push(next);
			if (budget.nodes <= 0 || budget.chars <= 0) break;
		}
		return bounded;
	}
	const bounded: Record<string, unknown> = Object.create(null);
	let keyCount = 0;
	for (const key in value) {
		if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
		if (keyCount++ >= MAX_OMP_ADVISOR_VALUE_KEYS || budget.chars <= 0) break;
		const keyLength = Math.min(key.length, MAX_OMP_ADVISOR_VALUE_KEY_CHARS, budget.chars);
		const boundedKey = redactText(key.slice(0, keyLength));
		budget.chars -= keyLength;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor)) continue;
		const item = boundedOmpAdvisorValue(descriptor.value, budget, depth + 1);
		if (item !== undefined) bounded[boundedKey] = item;
		if (budget.nodes <= 0 || budget.chars <= 0) break;
	}
	return bounded;
}

export function boundedOmpAdvisorQuery(updates: readonly unknown[]): string {
	const budget: OmpQueryBudget = {
		nodes: MAX_OMP_ADVISOR_QUERY_NODES,
		chars: MAX_OMP_ADVISOR_QUERY_VALUE_CHARS,
		seen: new Set(),
	};
	const parts: string[] = [];
	const recent = updates.slice(-MAX_OMP_ADVISOR_QUERY_MESSAGES);
	for (let index = recent.length - 1; index >= 0; index--) {
		const serialized = JSON.stringify(boundedOmpAdvisorValue(recent[index], budget));
		if (typeof serialized === "string") parts.unshift(redactText(serialized));
		if (budget.nodes <= 0 || budget.chars <= 0) break;
	}
	return parts.join("\n").slice(-MAX_OMP_ADVISOR_QUERY_CHARS);
}

export interface OmpExperienceAdvisorContext {
	context: string;
	experienceCount: number;
	assistantContextCount: number;
	attributions: ReadonlyMap<string, ExperienceRetrievalCandidate>;
}

export async function buildOmpExperienceAdvisorContext(db: DatabaseSync, input: HostExperienceContextInput): Promise<OmpExperienceAdvisorContext> {
	const retrieved = await retrieveApprovedHostExperienceContext(db, input);
	const all = buildExperienceContextPack(retrieved.candidates, "all");
	const nonce = randomUUID();
	const attributions = new Map<string, ExperienceRetrievalCandidate>();
	for (const candidate of retrieved.candidates) {
		if (candidate.experience.kind === "habit") attributions.set(`${nonce}:${candidate.alias}`, candidate);
	}
	const payload = {
		schemaVersion: 1,
		experienceContext: all.modelPayload,
	};
	return {
		context: [
			`[${OMP_EXPERIENCE_CONTEXT_MARKER} nonce=${nonce}]`,
			"Approved Experiences context for OMP's native Advisor. Only kind=habit entries can define runtime habit policy. Other kinds are bounded support context only. Decide current applicability from the live conversation. Direct user instructions and configured law still override all entries.",
			`When and only when an approved habit directly causes advice, set advise.attribution to \"${nonce}:<habit alias>\" using its exact alias below. Never put this attribution in the visible note and never set it for generic advice.`,
			JSON.stringify(payload),
		].join("\n"),
		experienceCount: payload.experienceContext.length,
		assistantContextCount: retrieved.assistantContext.modelPayload.length,
		attributions,
	};
}
