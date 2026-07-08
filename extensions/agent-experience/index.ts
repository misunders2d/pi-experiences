import { stat } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { summarizeAgentExperienceConfig } from "./src/config.ts";
import {
	getAgentExperiencePaths,
	readAgentExperienceConfig,
	setAgentExperienceCaptureEnabled,
	setAgentExperienceConsolidationEnabled,
	setAgentExperienceEnabled,
	setAgentExperienceSelectorEnabled,
} from "./src/paths.ts";
import { appendObservation } from "./src/storage/observations.ts";
import { initExperienceStorage, openExistingExperienceStorage } from "./src/storage/sqlite.ts";
import {
	acceptCandidateHabit,
	acceptPendingReview,
	diffPendingReviewItems,
	disableHabit,
	enableHabit,
	explainHabit,
	generateHabitsReport,
	listPendingReviewItems,
	readConfiguredLawSnapshot,
	rejectCandidateHabit,
	rejectPendingReview,
	showPendingReviewItem,
} from "./src/review.ts";
import { normalizeUserId, resolvePrivatePath } from "./src/storage/private-root.ts";
import { redactText } from "./src/storage/redaction.ts";
import { classifyCaptureInput, type CaptureKey } from "./src/capture/origin.ts";
import { CapturePairBuffer, buildPairPayload, type CompletedPair, type CloseReason } from "./src/capture/buffer.ts";
import { extractSingleFinalAssistantText } from "./src/capture/extract.ts";
import { runSelectorRuntime, type SelectorModelAdapter } from "./src/selector.ts";
import { createPiSelectorModelAdapter } from "./src/selector-model.ts";
import { collectAgentExperienceMetrics, formatAgentExperienceMetrics } from "./src/metrics.ts";

const captureBuffer = new CapturePairBuffer();
let selectorModelAdapter: SelectorModelAdapter | undefined;
const selectorDiagnosticsShown = new Set<string>();

export function __setAgentExperienceSelectorAdapterForTest(adapter: SelectorModelAdapter | undefined) {
	selectorModelAdapter = adapter;
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warn" | "error" = "info") {
	ctx.ui.notify(message, level);
}

function getConfiguredUserId(): string {
	return normalizeUserId(process.env.AX_USER_ID || "owner");
}

function captureKeyFromContext(ctx: Pick<ExtensionContext, "sessionManager"> | { sessionManager?: ExtensionContext["sessionManager"] }): CaptureKey | undefined {
	if (!ctx.sessionManager) return undefined;
	const sessionId = ctx.sessionManager.getSessionId?.();
	const sessionFile = ctx.sessionManager.getSessionFile?.();
	if (!sessionId || !sessionFile) return undefined;
	return { sessionId, sessionFile, userId: getConfiguredUserId() };
}

async function getEffectiveCapture(paths = getAgentExperiencePaths()) {
	const { config } = await readAgentExperienceConfig(paths);
	return { paths, config, active: config.enabled === true && config.capture_enabled === true };
}

async function appendCapturedPair(root: string, pair: CompletedPair, reason: CloseReason) {
	await appendObservation(root, {
		userId: pair.key.userId,
		origin: pair.origin,
		payload: buildPairPayload(pair, reason),
	});
}

async function handleStatus(ctx: ExtensionCommandContext) {
	const paths = getAgentExperiencePaths();
	const { config, exists, path } = await readAgentExperienceConfig(paths);
	let metrics = "metrics: ledger absent";
	if (await fileExists(resolvePrivatePath(paths.root, "ledger.sqlite"))) {
		const storage = await initExperienceStorage(paths.root, { allowInit: true, userId: getConfiguredUserId() });
		try {
			metrics = formatAgentExperienceMetrics(collectAgentExperienceMetrics(storage.db, { userId: storage.userId, staleThreshold: config.selector_staleness_max }));
		} finally {
			storage.db.close();
		}
	}
	notify(ctx, `${summarizeAgentExperienceConfig(config, path, exists)}\n${metrics}`, config.enabled ? "warn" : "info");
}

async function handleEnable(ctx: ExtensionCommandContext) {
	const { config, path } = await setAgentExperienceEnabled(true);
	notify(
		ctx,
		[
			"Agent Experience enabled flag written.",
			`config: ${path}`,
			"Phase 3 safety: capture still requires explicit /experience capture on; selector, embedding, consolidation, timer, model, and network work remain disabled.",
			`enabled=${config.enabled}`,
			`capture=${config.capture_enabled}`,
		].join("\n"),
		"warn",
	);
}

async function handleDisable(ctx: ExtensionCommandContext) {
	captureBuffer.clearAll();
	const { config, path } = await setAgentExperienceEnabled(false);
	notify(
		ctx,
		[
			"Agent Experience disabled.",
			`config: ${path}`,
			"No automatic writes, capture, selector, embedding, consolidation, timer, model, or network work is active.",
			"Disable drops in-memory capture buffers without writing observations.",
			`enabled=${config.enabled}`,
			`capture=${config.capture_enabled}`,
		].join("\n"),
		"info",
	);
}

function parseFlag(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	return args[index + 1];
}

function formatResult(value: unknown): string {
	return JSON.stringify(value, null, 2).slice(0, 6000);
}

function selectorDiagnostic(error: unknown): { key: string; message: string } {
	const raw = error instanceof Error ? error.message : String(error);
	const redacted = redactText(raw).slice(0, 500);
	return { key: `selector-runtime:${redacted}`, message: `Agent Experience selector skipped: ${redacted}` };
}

function notifySelectorDiagnostic(ctx: unknown, diagnostic: { key: string; message: string }): void {
	if (selectorDiagnosticsShown.has(diagnostic.key)) return;
	selectorDiagnosticsShown.add(diagnostic.key);
	const ui = (ctx as { ui?: { notify?: (message: string, level?: string) => void } })?.ui;
	try {
		if (typeof ui?.notify === "function") ui.notify(diagnostic.message, "warn");
		else console.warn(diagnostic.message);
	} catch {
		console.warn(diagnostic.message);
	}
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error: any) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

async function readConfiguredLawForRoot(root: string) {
	const paths = getAgentExperiencePaths();
	const { config } = await readAgentExperienceConfig(paths);
	return readConfiguredLawSnapshot(root, config);
}

async function withReviewStorage<T>(fn: (storage: Awaited<ReturnType<typeof initExperienceStorage>>) => Promise<T> | T): Promise<T> {
	const paths = getAgentExperiencePaths();
	const storage = await initExperienceStorage(paths.root, { allowInit: true, userId: getConfiguredUserId() });
	try {
		return await fn(storage);
	} finally {
		storage.db.close();
	}
}

async function handlePending(args: string[], ctx: ExtensionCommandContext) {
	const [action = "list", id] = args;
	const checksum = parseFlag(args, "--checksum");
	const now = new Date().toISOString();
	const result = await withReviewStorage(async (storage) => {
		switch (action) {
			case "list": return listPendingReviewItems(storage.db, { userId: storage.userId });
			case "show": if (!id) throw new Error("Usage: /experience pending show <id>"); return showPendingReviewItem(storage.db, { userId: storage.userId, id });
			case "diff": return diffPendingReviewItems(storage.db, { userId: storage.userId });
			case "accept": if (!id || !checksum) throw new Error("Usage: /experience pending accept <id> --checksum <checksum>"); return acceptPendingReview(storage.db, { userId: storage.userId, id, checksum, now });
			case "reject": if (!id || !checksum) throw new Error("Usage: /experience pending reject <id> --checksum <checksum>"); return rejectPendingReview(storage.db, { userId: storage.userId, id, checksum, now });
			default: throw new Error("Usage: /experience pending list|show|diff|accept|reject ...");
		}
	});
	notify(ctx, formatResult(result), "info");
}

async function handleHabit(args: string[], ctx: ExtensionCommandContext) {
	const [action, id] = args;
	const checksum = parseFlag(args, "--checksum");
	const now = new Date().toISOString();
	const result = await withReviewStorage(async (storage) => {
		switch (action) {
			case "explain": if (!id) throw new Error("Usage: /experience habit explain <id>"); return explainHabit(storage.db, { userId: storage.userId, habitId: id });
			case "accept": if (!id || !checksum) throw new Error("Usage: /experience habit accept <id> --checksum <checksum>"); return acceptCandidateHabit(storage.db, { userId: storage.userId, habitId: id, checksum, law: await readConfiguredLawForRoot(storage.root), now });
			case "reject": if (!id || !checksum) throw new Error("Usage: /experience habit reject <id> --checksum <checksum>"); return rejectCandidateHabit(storage.db, { userId: storage.userId, habitId: id, checksum, now });
			case "disable": if (!id || !checksum) throw new Error("Usage: /experience habit disable <id> --checksum <checksum>"); return disableHabit(storage.db, { userId: storage.userId, habitId: id, checksum, now });
			case "enable": if (!id || !checksum) throw new Error("Usage: /experience habit enable <id> --checksum <checksum>"); return enableHabit(storage.db, { userId: storage.userId, habitId: id, checksum, law: await readConfiguredLawForRoot(storage.root), now });
			default: throw new Error("Usage: /experience habit explain|accept|reject|disable|enable ...");
		}
	});
	notify(ctx, formatResult(result), "info");
}

async function handleHabits(args: string[], ctx: ExtensionCommandContext) {
	const [action] = args;
	if (action !== "report") throw new Error("Usage: /experience habits report");
	const now = new Date().toISOString();
	const result = await withReviewStorage(async (storage) => generateHabitsReport(storage.db, { root: storage.root, userId: storage.userId, now }));
	notify(ctx, `Generated report-only ${result.path}\n${formatResult({ user_id: result.user_id, report_only: result.report_only, injectable: result.injectable })}`, "info");
}

async function handleConsolidation(command: string | undefined, ctx: ExtensionCommandContext) {
	const value = (command || "").toLowerCase();
	if (value !== "on" && value !== "off") {
		return notify(ctx, "Usage: /experience consolidation on|off", "warn");
	}
	const { config, path } = await setAgentExperienceConsolidationEnabled(value === "on");
	notify(
		ctx,
		[
			`Agent Experience consolidation ${value === "on" ? "enabled" : "disabled"} flag written.`,
			`config: ${path}`,
			"Consolidation is manual in this release: run experience-consolidate status/now explicitly; no timer or live model adapter is enabled.",
			`enabled=${config.enabled}`,
			`capture=${config.capture_enabled}`,
			`consolidation=${config.consolidation_enabled}`,
		].join("\n"),
		value === "on" ? "warn" : "info",
	);
}

async function handleSelector(command: string | undefined, ctx: ExtensionCommandContext) {
	const value = (command || "").toLowerCase();
	if (value === "calibrate") {
		return withReviewStorage((storage) => notify(ctx, `${formatAgentExperienceMetrics(collectAgentExperienceMetrics(storage.db, { userId: storage.userId }))}\nManual weekly calibration: spot-check recent inject rows by mode, disable stale habits manually, and keep smart mode opt-in. No recurring reminder is enabled by this command.`, "info"));
	}
	if (value !== "on" && value !== "off") {
		return notify(ctx, "Usage: /experience selector on|off|calibrate", "warn");
	}
	const { config, path } = await setAgentExperienceSelectorEnabled(value === "on");
	notify(
		ctx,
		[
			`Agent Experience pre-injection/selector ${value === "on" ? "enabled" : "disabled"} flag written.`,
			`config: ${path}`,
			"Selector is effective only when Agent Experience is also enabled and reviewed active habits exist.",
			config.selector_mode === "instant"
				? "Selector mode instant: local lexical/no-network selection from active habits only; smart/model calls remain opt-in."
				: "Selector mode smart: each user prompt may send per-prompt redacted selector payloads with bounded active-habit summaries to the configured selector model/provider and may write bounded redacted hit logs.",
			"Selector never reads reports, pending review, quarantine, evidence, disabled/suppressed/dormant/candidate/archived rows, and never promotes or activates habits.",
			`enabled=${config.enabled}`,
			`selector=${config.selector_enabled}`,
			`selector_mode=${config.selector_mode}`,
			`selector_model=${config.selector_model}`,
			`selector_daily_budget=${config.selector_daily_budget}`,
		].join("\n"),
		value === "on" ? "warn" : "info",
	);
}

async function handleCapture(command: string | undefined, ctx: ExtensionCommandContext) {
	const value = (command || "").toLowerCase();
	if (value !== "on" && value !== "off") {
		return notify(ctx, "Usage: /experience capture on|off", "warn");
	}
	if (value === "off") captureBuffer.clearAll();
	const { config, path } = await setAgentExperienceCaptureEnabled(value === "on");
	notify(
		ctx,
		[
			`Agent Experience capture ${value === "on" ? "enabled" : "disabled"} flag written.`,
			`config: ${path}`,
			"Capture is effective only when Agent Experience is also enabled; capture off/disable drops in-memory buffers without writing observations.",
			`enabled=${config.enabled}`,
			`capture=${config.capture_enabled}`,
		].join("\n"),
		value === "on" ? "warn" : "info",
	);
}

function usage(topic = "") {
	const normalized = topic.toLowerCase();
	if (normalized === "setup") {
		return [
			"Agent Experience setup:",
			"1. /experience status        # inspect flags and storage path",
			"2. /experience enable        # master switch only",
			"3. /experience capture on    # collect redacted conversation pairs",
			"4. Work normally for a few turns/sessions.",
			"5. /experience consolidation on # allow/manual-track consolidation work",
			"6. Run experience-consolidate now --fixture-output <file> to consolidate observations into review candidates.",
			"7. /experience pending list  # review candidates after consolidation exists",
			"8. /experience selector on   # pre-injection from approved active habits only",
			"No automatic timer/model adapter is installed by default."
		].join("\n");
	}
	if (normalized === "review") {
		return [
			"Agent Experience review commands:",
			"/experience pending list",
			"/experience pending show <id>",
			"/experience pending diff",
			"/experience pending accept <id> --checksum <checksum>",
			"/experience pending reject <id> --checksum <checksum>",
			"/experience habit explain <id>",
			"/experience habit accept|reject|disable|enable <id> --checksum <checksum>",
			"/experience habits report",
		].join("\n");
	}
	if (normalized === "selector") {
		return [
			"Agent Experience selector:",
			"/experience selector on       # pre-injection; instant mode by default; local lexical/no-network",
			"/experience selector off",
			"/experience selector calibrate # manual aggregate check; no recurring reminder",
			"Selector defaults disabled. When enabled, default mode is instant (local lexical/no-network). Smart mode is opt-in and may call the configured model/provider.",
			"Selector only considers active same-user habits and never promotes habits.",
		].join("\n");
	}
	if (normalized === "troubleshoot") {
		return [
			"Agent Experience troubleshooting:",
			"/experience status                 # verify enabled=true and capture=true",
			"ls -la ~/.agents/experience        # config and observations.jsonl live here by default",
			"tail -3 ~/.agents/experience/observations.jsonl",
			"experience-consolidate status # verify bundled CLI can read config; consolidation is manual",
			"If no observations appear after a normal turn, restart Pi so the latest extension code is loaded.",
			"Capture writes completed turns at agent_end; selector/ledger are separate.",
		].join("\n");
	}
	return [
		"Agent Experience help:",
		"/experience status",
		"/experience help setup     # first-run flow",
		"/experience help review    # approve/reject habits",
		"/experience help selector  # injection controls",
		"/experience help troubleshoot",
		"/experience enable|disable",
		"/experience capture on|off",
		"/experience consolidation on|off",
		"/experience selector on|off|calibrate",
		"/experience pending list|show|diff|accept|reject",
		"/experience habit explain <id>",
		"/experience habit accept|reject|disable|enable <id> --checksum <checksum>",
		"/experience habits report",
		"Selector defaults disabled. When enabled, default mode is instant (local lexical/no-network). Smart mode is opt-in and may call the configured model/provider.",
		"embeddings, timers, live runtime install, report injection, and selector-driven habit activation remain out of scope unless explicitly enabled/approved.",
		"habits-report.md is report-only generated data, never policy or selector/injection input.",
		"Usage: /experience help setup|review|selector|troubleshoot",
	].join("\n");
}

export default function agentExperienceExtension(pi: ExtensionAPI) {
	pi.registerCommand("experience", {
		description: "Agent Experience controls: status, enable/disable, capture, consolidation, selector/pre-injection, pending review, habits report",
		handler: async (args, ctx) => {
			const [command = "status", subcommand] = String(args || "").trim().split(/\s+/).filter(Boolean);
			switch (command.toLowerCase()) {
				case "status":
					await handleStatus(ctx);
					return;
				case "enable":
					await handleEnable(ctx);
					return;
				case "disable":
					await handleDisable(ctx);
					return;
				case "capture":
					await handleCapture(subcommand, ctx);
					return;
				case "consolidation":
				case "consolidate":
					await handleConsolidation(subcommand, ctx);
					return;
				case "selector":
				case "pre-injection":
				case "preinject":
				case "injection":
					await handleSelector(subcommand, ctx);
					return;
				case "pending":
					await handlePending([subcommand, ...String(args || "").trim().split(/\s+/).filter(Boolean).slice(2)].filter(Boolean), ctx);
					return;
				case "habit":
					await handleHabit([subcommand, ...String(args || "").trim().split(/\s+/).filter(Boolean).slice(2)].filter(Boolean), ctx);
					return;
				case "habits":
					await handleHabits([subcommand, ...String(args || "").trim().split(/\s+/).filter(Boolean).slice(2)].filter(Boolean), ctx);
					return;
				case "help":
				case "--help":
				case "-h":
					return notify(ctx, usage(subcommand), "info");
				default:
					return notify(ctx, `${usage()}\nUnknown subcommand: ${command}`, "warn");
			}
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const paths = getAgentExperiencePaths();
		const { config } = await readAgentExperienceConfig(paths);
		if (!config.enabled || !config.selector_enabled) return;
		const prompt = String((event as { prompt?: unknown; text?: unknown }).prompt ?? (event as { text?: unknown }).text ?? "");
		if (!prompt.trim()) return;
		if (!(await fileExists(resolvePrivatePath(paths.root, "ledger.sqlite")))) return;
		let storage: Awaited<ReturnType<typeof openExistingExperienceStorage>> | undefined;
		try {
			storage = await openExistingExperienceStorage(paths.root, { userId: getConfiguredUserId() });
			const law = await readConfiguredLawSnapshot(storage.root, config);
			const adapter = selectorModelAdapter ?? createPiSelectorModelAdapter(ctx);
			const result = await runSelectorRuntime(storage.db, { userId: storage.userId, prompt, config, law, now: new Date().toISOString(), adapter });
			if (!result.injected || !result.message) return;
			const basePrompt = String((event as { systemPrompt?: unknown }).systemPrompt ?? "");
			return { systemPrompt: `${basePrompt}\n\n${result.message}` };
		} catch (error: any) {
			notifySelectorDiagnostic(ctx, selectorDiagnostic(error));
			return;
		} finally {
			storage?.db.close();
		}
	});

	pi.on("input", async (event, ctx) => {
		const { paths, active } = await getEffectiveCapture();
		if (!active) {
			captureBuffer.clearAll();
			return;
		}
		const key = captureKeyFromContext(ctx);
		const decision = classifyCaptureInput({
			text: event.text,
			images: event.images,
			source: event.source,
			streamingBehavior: event.streamingBehavior,
			sessionId: key?.sessionId,
			sessionFile: key?.sessionFile,
			userId: key?.userId,
		});
		if (!decision.allow) {
			captureBuffer.dropKey(decision.key || key);
			return;
		}
		try {
			await captureBuffer.acceptInput(
				{ key: decision.key, text: decision.text, origin: decision.origin, createdAt: new Date().toISOString() },
				(pair, reason) => appendCapturedPair(paths.root, pair, reason),
			);
		} catch {
			captureBuffer.dropKey(decision.key);
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		const { paths, active } = await getEffectiveCapture();
		const key = captureKeyFromContext(ctx);
		if (!active) {
			captureBuffer.dropKey(key);
			return;
		}
		if (!key) return;
		const assistantText = extractSingleFinalAssistantText(event.messages as unknown[]);
		if (!assistantText) {
			captureBuffer.dropKey(key);
			return;
		}
		try {
			captureBuffer.completeAgentEnd(key, assistantText);
			await captureBuffer.flushKey(key, "agent_end", (pair, reason) => appendCapturedPair(paths.root, pair, reason));
		} catch {
			captureBuffer.dropKey(key);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const { paths, active } = await getEffectiveCapture();
		const key = captureKeyFromContext(ctx);
		if (!active || !key) {
			captureBuffer.dropKey(key);
			return;
		}
		try {
			await captureBuffer.flushKey(key, "session_shutdown", (pair, reason) => appendCapturedPair(paths.root, pair, reason));
		} catch {
			captureBuffer.dropKey(key);
		}
	});
}
