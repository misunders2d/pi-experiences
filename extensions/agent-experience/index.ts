import { readFile, stat } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getAgentExperiencePaths,
	readAgentExperienceConfig,
	setAgentExperienceCaptureActive,
	setAgentExperienceCaptureEnabled,
	setAgentExperienceConsolidationEnabled,
	setAgentExperienceEnabled,
	setAgentExperienceSelectorEnabled,
	setAgentExperienceSimpleOn,
	setAgentExperienceTimerEnabled,
} from "./src/paths.ts";
import { appendObservation } from "./src/storage/observations.ts";
import { initExperienceStorage, loadSqlite, openExistingExperienceStorage } from "./src/storage/sqlite.ts";
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
import { STORAGE_SCHEMA_VERSION } from "./src/storage/schema.ts";

const captureBuffer = new CapturePairBuffer();
let selectorModelAdapter: SelectorModelAdapter | undefined;
const selectorDiagnosticsShown = new Set<string>();
const captureDiagnosticsShown = new Set<string>();

export function __setAgentExperienceSelectorAdapterForTest(adapter: SelectorModelAdapter | undefined) {
	selectorModelAdapter = adapter;
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warn" | "error" = "info") {
	try {
		const ui = (ctx as { ui?: { notify?: (message: string, level?: string) => void } })?.ui;
		if (typeof ui?.notify === "function") return ui.notify(message, level);
		const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
		sink(message);
	} catch {
		const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
		sink(message);
	}
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

async function countObservationLines(root: string): Promise<number | undefined> {
	try {
		const text = await readFile(resolvePrivatePath(root, "observations.jsonl"), "utf8");
		if (!text.trim()) return 0;
		return text.split(/\r?\n/).filter((line) => line.trim()).length;
	} catch (error: any) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

async function reviewSummary(root: string, userId: string): Promise<{ ledger: boolean; pending: number; active: number; candidate: number; error?: string }> {
	const dbPath = resolvePrivatePath(root, "ledger.sqlite");
	if (!(await fileExists(dbPath))) return { ledger: false, pending: 0, active: 0, candidate: 0 };
	let db: any | undefined;
	try {
		const sqlite = await loadSqlite();
		db = new sqlite.DatabaseSync(dbPath, { open: true, readOnly: true });
		const normalizedUserId = normalizeUserId(userId);
		const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
		if (version !== STORAGE_SCHEMA_VERSION) throw new Error(`Agent Experience storage schema mismatch: expected ${STORAGE_SCHEMA_VERSION}, got ${version}`);
		const pending = Number(db.prepare("SELECT COUNT(*) AS count FROM pending_review WHERE user_id = ? AND status = 'open'").get(normalizedUserId).count);
		const candidate = Number(db.prepare("SELECT COUNT(*) AS count FROM habits WHERE user_id = ? AND status = 'candidate'").get(normalizedUserId).count);
		const active = Number(db.prepare("SELECT COUNT(*) AS count FROM habits WHERE user_id = ? AND status = 'active'").get(normalizedUserId).count);
		return { ledger: true, pending, active, candidate };
	} catch (error) {
		const raw = error instanceof Error ? error.message : String(error);
		return { ledger: true, pending: 0, active: 0, candidate: 0, error: redactText(raw).slice(0, 300) };
	} finally {
		db?.close();
	}
}

async function handleStatus(ctx: ExtensionCommandContext) {
	const paths = getAgentExperiencePaths();
	const { config, exists, path } = await readAgentExperienceConfig(paths);
	const observations = await countObservationLines(paths.root);
	const summary = await reviewSummary(paths.root, getConfiguredUserId());
	const captureActive = config.enabled && config.capture_enabled;
	const selectorActive = config.enabled && config.selector_enabled;
	const reviewCount = summary.pending + summary.candidate;
	const nextStep = !config.enabled
		? "Choose Save chat examples locally in /experience setup."
		: reviewCount > 0
			? "Choose Review suggested habits in /experience setup, or run /experience review."
			: "No suggested habits yet. This release saves examples locally but does not analyze them in the background.";
	notify(ctx, [
		`Experience: ${config.enabled ? "ON" : "OFF"}`,
		`Config file: ${path}${exists ? "" : " (not created; using defaults)"}`,
		`Save chat examples locally: ${captureActive ? "ON" : "OFF"}${observations === undefined ? "" : ` (${plural(observations, "saved example")})`}`,
		`Suggest habits from saved examples when I ask: ${config.consolidation_enabled ? "ON (manual only; no timer/model job running)" : "OFF"}`,
		`Review suggested habits: ${summary.error ? `ledger unreadable (${summary.error})` : summary.ledger ? `${plural(reviewCount, "suggestion")} waiting, ${plural(summary.active, "approved habit")}` : "no review list yet"}`,
		`Use approved habits before replies: ${selectorActive ? (config.selector_mode === "instant" ? "ON (local/no-network)" : `ON (${config.selector_mode})`) : config.selector_enabled ? "configured ON, inactive because Experience is OFF" : "OFF"}`,
		"Background learning: OFF / not available",
		"Automatic model/network learning: OFF in normal UX",
		`Next: ${nextStep}`,
	].join("\n"), config.enabled ? "info" : "warn");
}

function checkbox(value: boolean): "[x]" | "[ ]" {
	return value ? "[x]" : "[ ]";
}

function buildSetupOptions(config: { enabled: boolean; capture_enabled: boolean; consolidation_enabled: boolean; selector_enabled: boolean }): string[] {
	const captureActive = config.enabled && config.capture_enabled;
	const anythingEnabled = config.enabled || config.capture_enabled || config.consolidation_enabled || config.selector_enabled;
	return [
		captureActive ? "[x] Save chat examples locally" : "[ ] Save chat examples locally — turn on first",
		`${checkbox(config.consolidation_enabled)} Suggest habits from saved examples when I ask`,
		`${checkbox(config.selector_enabled)} Use approved habits before replies`,
		"Background learning: off / not available (explain)",
		"Review suggested habits",
		"Show current settings",
		"Explain these settings",
		...(anythingEnabled ? ["Turn all experience features off"] : []),
		"Done",
	];
}

function setupControlsMessage(): string {
	return [
		"Agent Experience setup controls — no config changed yet.",
		"Menu items are toggles and the menu returns after each change.",
		"If no menu appears or selection is unavailable, use these plain commands:",
		"/experience setup save on|off          # save chat examples locally",
		"/experience setup suggest on|off       # allow habit suggestions when you ask",
		"/experience setup use-habits on|off    # use approved habits before replies",
		"/experience setup background off       # keep background learning off",
		"/experience setup review              # review suggested habits",
		"/experience setup status              # show current settings",
		"/experience setup help                # explain these settings",
		"/experience setup off                 # turn all experience features off",
	].join("\n");
}

function setupUnavailableMessage(): string {
	return setupControlsMessage();
}

function setupHelpMessage(config: { enabled: boolean; capture_enabled: boolean; consolidation_enabled: boolean; selector_enabled: boolean; selector_mode: string; selector_model: string }): string {
	const anythingEnabled = config.enabled || config.capture_enabled || config.consolidation_enabled || config.selector_enabled;
	return [
		"Agent Experience setup help:",
		"[x] means ON. [ ] means OFF. Press Enter on a setting to toggle it; choose Done to exit.",
		"Save chat examples locally: turn this on first to start saving examples. It stores redacted completed user/assistant pairs under ~/.agents/experience. It does not store raw full prompts or injected text.",
		"Suggest habits from saved examples when I ask: lets you manually ask Pi to analyze saved examples and propose habits. It does not run in the background and does not auto-approve anything.",
		config.selector_mode === "instant"
			? "Use approved habits before replies: lets Pi add only human-approved habits as reminders before future replies. Current mode is local/no-network."
			: `Use approved habits before replies: lets Pi add only human-approved habits as reminders before future replies. Current mode may call ${config.selector_model} with bounded redacted selector payloads.`,
		"Background learning: unavailable in this package release. Setup will not install, enable, or start a timer.",
		"Review suggested habits: opens the list of proposed habits for you to approve or reject. Nothing is auto-approved.",
		anythingEnabled
			? "Turn all experience features off: stops capture and all runtime gates. Existing local records are preserved."
			: "When a setting is on, a Turn all experience features off row appears here to stop all runtime gates.",
	].join("\n");
}

async function chooseSetup(ctx: ExtensionCommandContext, title: string, options: readonly string[], showUnavailable = true): Promise<string | undefined> {
	const ui = (ctx as { hasUI?: boolean; ui?: { select?: (title: string, options: string[]) => Promise<string | undefined> | string | undefined } })?.ui;
	if ((ctx as { hasUI?: boolean }).hasUI === false || typeof ui?.select !== "function") {
		if (showUnavailable) notify(ctx, setupUnavailableMessage(), "info");
		return undefined;
	}
	try {
		const choice = await ui.select(title, [...options]);
		if (!choice) return undefined;
		if (!options.includes(choice)) {
			notify(ctx, `Agent Experience setup ignored unknown menu choice: ${redactText(choice).slice(0, 200)}\nNo config changed.`, "warn");
			return undefined;
		}
		return choice;
	} catch (error) {
		const raw = error instanceof Error ? error.message : String(error);
		notify(ctx, `Agent Experience setup menu failed: ${redactText(raw).slice(0, 300)}\nNo config changed.`, "warn");
		return undefined;
	}
}

async function handleSetupConsolidation(ctx: ExtensionCommandContext) {
	const choice = await chooseSetup(ctx, "Suggest habits from saved examples", [
		"Explain habit suggestions (no changes)",
		"Allow manual habit suggestions when I ask",
		"Do not suggest habits",
		"Back/cancel (no changes)",
	]);
	if (!choice || choice === "Back/cancel (no changes)") return notify(ctx, "Habit-suggestion setup cancelled. No config changed.", "info");
	if (choice === "Explain habit suggestions (no changes)") {
		return notify(ctx, [
			"Habit suggestions means Pi can turn saved examples into proposed habits for you to review.",
			"This release does not run that automatically: no timer and no live model job are installed.",
			"Turning this on only allows explicit/manual candidate generation. It does not create or approve habits by itself.",
		].join("\n"), "info");
	}
	if (choice === "Allow manual habit suggestions when I ask") return handleConsolidation("on", ctx);
	if (choice === "Do not suggest habits") return handleConsolidation("off", ctx);
	return notify(ctx, "Habit-suggestion setup cancelled. No config changed.", "info");
}

async function handleSetupSelector(ctx: ExtensionCommandContext) {
	const choice = await chooseSetup(ctx, "Use approved habits before replies", [
		"Explain approved-habit reminders (no changes)",
		"Use approved habits before replies",
		"Do not use approved habits before replies",
		"Back/cancel (no changes)",
	]);
	if (!choice || choice === "Back/cancel (no changes)") return notify(ctx, "Approved-habit reminder setup cancelled. No config changed.", "info");
	if (choice === "Explain approved-habit reminders (no changes)") {
		return notify(ctx, [
			"Approved-habit reminders means Pi can add only human-approved habits as reminders before a reply.",
			"It never uses unreviewed suggestions and never approves habits by itself.",
			"Default mode is local/no-network. Advanced smart mode may call a configured model/provider only if separately configured.",
		].join("\n"), "info");
	}
	if (choice === "Use approved habits before replies") return handleSelector("on", ctx);
	if (choice === "Do not use approved habits before replies") return handleSelector("off", ctx);
	return notify(ctx, "Approved-habit reminder setup cancelled. No config changed.", "info");
}

async function handleSetupTimer(ctx: ExtensionCommandContext) {
	const choice = await chooseSetup(ctx, "Background learning", [
		"Explain background learning (no changes)",
		"Keep background learning disabled",
		"Show advanced timer notes (no changes)",
		"Back/cancel (no changes)",
	]);
	if (!choice || choice === "Back/cancel (no changes)") return notify(ctx, "Timer setup cancelled. No config changed.", "info");
	if (choice === "Keep background learning disabled") {
		const { config, path } = await setAgentExperienceTimerEnabled(false);
		return notify(ctx, [
			"Background learning remains disabled. No systemd unit was installed or started.",
			`Config file: ${path}`,
			`Suggest habits from saved examples when I ask: ${config.consolidation_enabled ? "ON" : "OFF"}`,
			"Background learning: OFF",
			"Break-in/interruption behavior: OFF",
		].join("\n"), "info");
	}
	return notify(ctx, [
		"Timer/background learning would mean a scheduled job periodically tries to create review candidates from captures.",
		"This release does not provide a package-owned timer or live consolidation adapter.",
		"The bundled systemd files are disabled maintainer templates only and are not installed by /experience setup/on.",
		"So there is no timer to manage for normal users right now.",
	].join("\n"), "info");
}

async function handleSetupDirect(args: string[], ctx: ExtensionCommandContext): Promise<boolean> {
	const [action = "", value = ""] = args.map((arg) => arg.toLowerCase());
	if (!action) return false;
	switch (action) {
		case "1":
		case "on":
		case "enable":
			await handleOn(ctx);
			return true;
		case "save":
		case "capture":
			if (value === "on" || value === "enable") {
				const { config, path } = await setAgentExperienceCaptureActive(true);
				notify(ctx, [`Save chat examples locally: ON`, `Config file: ${path}`, `Current setting: ${config.capture_enabled ? "ON" : "OFF"}`].join("\n"), "info");
			} else if (value === "off" || value === "disable") {
				const { config, path } = await setAgentExperienceCaptureActive(false);
				notify(ctx, [`Save chat examples locally: OFF`, `Config file: ${path}`, `Current setting: ${config.capture_enabled ? "ON" : "OFF"}`].join("\n"), "info");
			} else notify(ctx, "Usage: /experience setup save on|off", "warn");
			return true;
		case "2":
		case "off":
		case "disable":
			await handleOff(ctx);
			return true;
		case "3":
		case "status":
			await handleStatus(ctx);
			return true;
		case "4":
		case "review":
			await handleReview(value ? args.slice(1) : ["list"], ctx);
			return true;
		case "5":
		case "suggest":
		case "habits":
		case "consolidation":
		case "consolidate":
		case "learning":
			if (value === "on" || value === "enable") await handleConsolidation("on", ctx);
			else if (value === "off" || value === "disable") await handleConsolidation("off", ctx);
			else notify(ctx, "Usage: /experience setup suggest on|off", "warn");
			return true;
		case "6":
		case "use-habits":
		case "approved-habits":
		case "reminders":
		case "guidance":
		case "selector":
		case "pre-injection":
		case "preinject":
			if (value === "on" || value === "enable") await handleSelector("on", ctx);
			else if (value === "off" || value === "disable") await handleSelector("off", ctx);
			else notify(ctx, "Usage: /experience setup use-habits on|off", "warn");
			return true;
		case "7":
		case "background":
		case "timer":
			if (!value || value === "explain" || value === "status") await handleSetupTimer(ctx);
			else if (value === "off" || value === "disable") {
				const { config, path } = await setAgentExperienceTimerEnabled(false);
				notify(ctx, [`Background learning: OFF`, `Config file: ${path}`, `Break-in/interruption behavior: ${config.break_in_enabled ? "ON" : "OFF"}`].join("\n"), "info");
			} else notify(ctx, "Usage: /experience setup background off", "warn");
			return true;
		case "8":
		case "help": {
			const { config } = await readAgentExperienceConfig(getAgentExperiencePaths());
			notify(ctx, setupHelpMessage(config), "info");
			return true;
		}
		case "advanced":
			notify(ctx, usage("advanced"), "info");
			return true;
		case "9":
		case "cancel":
			notify(ctx, "Agent Experience setup cancelled. No config changed.", "info");
			return true;
		default:
			notify(ctx, `${setupUnavailableMessage()}\nUnknown setup action: ${redactText(action).slice(0, 120)}\nNo config changed.`, "warn");
			return true;
	}
}

async function handleSetup(ctx: ExtensionCommandContext, args: string[] = []) {
	if (await handleSetupDirect(args, ctx)) return;
	if ((ctx as { hasUI?: boolean }).hasUI === false || typeof (ctx as { ui?: { select?: unknown } }).ui?.select !== "function") {
		notify(ctx, setupUnavailableMessage(), "info");
		return;
	}
	while (true) {
		const { config } = await readAgentExperienceConfig(getAgentExperiencePaths());
		const options = buildSetupOptions(config);
		const choice = await chooseSetup(ctx, "Agent Experience Settings — Enter toggles, Explain explains, Done exits", options, false);
		if (!choice || choice === "Done") return notify(ctx, "Agent Experience setup closed.", "info");
		if (choice === "Show current settings") {
			await handleStatus(ctx);
			continue;
		}
		if (choice === "Review suggested habits") {
			await handleReview(["list"], ctx);
			continue;
		}
		if (choice === "Explain these settings") {
			notify(ctx, setupHelpMessage(config), "info");
			continue;
		}
		if (choice === "Turn all experience features off") {
			await handleOff(ctx);
			continue;
		}
		if (choice.startsWith("Background learning")) {
			await handleSetupTimer(ctx);
			continue;
		}
		if (choice.endsWith("Suggest habits from saved examples when I ask")) {
			await handleConsolidation(config.consolidation_enabled ? "off" : "on", ctx);
			continue;
		}
		if (choice.endsWith("Use approved habits before replies")) {
			await handleSelector(config.selector_enabled ? "off" : "on", ctx);
			continue;
		}
		if (choice.includes("Save chat examples locally")) {
			if (config.enabled && config.capture_enabled) captureBuffer.clearAll();
			const { config: updated, path } = await setAgentExperienceCaptureActive(!(config.enabled && config.capture_enabled));
			notify(ctx, [
				`Save chat examples locally: ${updated.enabled && updated.capture_enabled ? "ON" : "OFF"}`,
				`Config file: ${path}`,
				`Suggest habits from saved examples when I ask: ${updated.consolidation_enabled ? "ON" : "OFF"}`,
				`Use approved habits before replies: ${updated.selector_enabled ? "ON" : "OFF"}`, 
			].join("\n"), "info");
			continue;
		}
		return notify(ctx, "Agent Experience setup closed. No further changes.", "info");
	}
}

async function handleOn(ctx: ExtensionCommandContext) {
	const { path } = await setAgentExperienceSimpleOn();
	notify(
		ctx,
		[
			"Agent Experience is ON.",
			`Config file: ${path}`,
			"Save chat examples locally: ON",
			"Suggest habits from saved examples when I ask: OFF in normal on/off mode",
			"Use approved habits before replies: OFF in normal on/off mode",
			"Background learning: OFF",
			"Run /experience status anytime for counts and next step.",
		].join("\n"),
		"info",
	);
}

async function handleOff(ctx: ExtensionCommandContext) {
	captureBuffer.clearAll();
	const { path } = await setAgentExperienceEnabled(false);
	notify(
		ctx,
		[
			"Agent Experience is OFF.",
			`Config file: ${path}`,
			"Save chat examples locally: OFF",
			"Suggest habits from saved examples when I ask: OFF",
			"Use approved habits before replies: OFF",
			"Background learning: OFF",
			"Off drops in-memory capture buffers without writing observations. Existing records are preserved.",
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

function formatReviewReadError(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return `Review ledger unreadable (${redactText(raw).slice(0, 300)}). No review changes were made.`;
}

function diagnosticFor(kind: "selector-runtime" | "capture-persist", error: unknown): { key: string; message: string } {
	const raw = error instanceof Error ? error.message : String(error);
	const redacted = redactText(raw).slice(0, 500);
	if (kind === "selector-runtime") {
		const lawMissing = /law file missing/i.test(redacted);
		return {
			key: `${kind}:${redacted}`,
			message: lawMissing
				? `Agent Experience approved-habit reminders are paused because the required law file is missing. To stop this warning, run /experience setup use-habits off, or create the configured law file. Detail: ${redacted}`
				: `Agent Experience approved-habit reminders are paused: ${redacted}`,
		};
	}
	return {
		key: `${kind}:${redacted}`,
		message: `Agent Experience could not save this turn's example: ${redacted}`,
	};
}

function notifyDedupedDiagnostic(ctx: unknown, seen: Set<string>, diagnostic: { key: string; message: string }): void {
	if (seen.has(diagnostic.key)) return;
	seen.add(diagnostic.key);
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

async function withExistingReviewStorage<T>(fn: (storage: { db: any; root: string; userId: string }) => Promise<T> | T): Promise<T> {
	const paths = getAgentExperiencePaths();
	const dbPath = resolvePrivatePath(paths.root, "ledger.sqlite");
	const sqlite = await loadSqlite();
	const db = new sqlite.DatabaseSync(dbPath, { open: true, readOnly: true });
	try {
		const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
		if (version !== STORAGE_SCHEMA_VERSION) throw new Error(`Agent Experience storage schema mismatch: expected ${STORAGE_SCHEMA_VERSION}, got ${version}`);
		return await fn({ db, root: paths.root, userId: getConfiguredUserId() });
	} finally {
		db.close();
	}
}

async function handleReview(args: string[], ctx: ExtensionCommandContext) {
	const [action = "list", id] = args;
	const paths = getAgentExperiencePaths();
	if (!(await fileExists(resolvePrivatePath(paths.root, "ledger.sqlite")))) {
		return notify(ctx, [
			"No review ledger yet.",
			"Capture may be accumulating redacted observations, but no candidates exist yet.",
			"This release does not run background consolidation, install a timer, or call a live consolidation model automatically.",
			"Normal commands: /experience status, /experience on, /experience off.",
		].join("\n"), "info");
	}
	if (action === "list") {
		try {
			const result = await withExistingReviewStorage(async (storage) => listPendingReviewItems(storage.db, { userId: storage.userId }));
			return notify(ctx, result.items.length
				? formatResult(result)
				: "No review items yet. Captures can exist without candidates because this release has no automatic consolidation/model/timer.", "info");
		} catch (error) {
			return notify(ctx, formatReviewReadError(error), "warn");
		}
	}
	if (action === "show") {
		if (!id) return notify(ctx, "Usage: /experience review show <id>", "warn");
		try {
			const result = await withExistingReviewStorage(async (storage) => showPendingReviewItem(storage.db, { userId: storage.userId, id }));
			return notify(ctx, formatResult(result), "info");
		} catch (error) {
			return notify(ctx, formatReviewReadError(error), "warn");
		}
	}
	if (action === "diff") {
		try {
			const result = await withExistingReviewStorage(async (storage) => diffPendingReviewItems(storage.db, { userId: storage.userId }));
			return notify(ctx, formatResult(result), "info");
		} catch (error) {
			return notify(ctx, formatReviewReadError(error), "warn");
		}
	}
	if (action === "accept" || action === "reject") {
		const checksum = parseFlag(args, "--checksum");
		if (!id || !checksum) return notify(ctx, `Usage: /experience review ${action} <id> --checksum <checksum>`, "warn");
		const now = new Date().toISOString();
		const result = await withReviewStorage(async (storage) => {
			const shown = showPendingReviewItem(storage.db, { userId: storage.userId, id });
			if (shown.item.type === "candidate") {
				return action === "accept"
					? acceptCandidateHabit(storage.db, { userId: storage.userId, habitId: id, checksum, law: await readConfiguredLawForRoot(storage.root), now })
					: rejectCandidateHabit(storage.db, { userId: storage.userId, habitId: id, checksum, now });
			}
			return action === "accept"
				? acceptPendingReview(storage.db, { userId: storage.userId, id, checksum, now })
				: rejectPendingReview(storage.db, { userId: storage.userId, id, checksum, now });
		});
		return notify(ctx, formatResult(result), "info");
	}
	if (action === "report") {
		return handleHabits(["report"], ctx);
	}
	return notify(ctx, "Usage: /experience review [list|show|diff|accept|reject|report] ...", "warn");
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
			`Suggest habits from saved examples when I ask: ${value === "on" ? "ON" : "OFF"}`,
			`Config file: ${path}`,
			"This is manual only in this release: no background job, timer, or live model job starts automatically.",
			`Save chat examples locally: ${config.enabled && config.capture_enabled ? "ON" : "OFF"}`,
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
			`Use approved habits before replies: ${value === "on" ? "ON" : "OFF"}`,
			`Config file: ${path}`,
			"This works only when Experience is ON and approved habits exist.",
			config.selector_mode === "instant"
				? "Current mode: local/no-network reminders from approved habits only."
				: "Current mode: smart reminders may call the configured model/provider with bounded redacted summaries.",
			"It never uses unreviewed suggestions and never approves habits by itself.",
			`Save chat examples locally: ${config.enabled && config.capture_enabled ? "ON" : "OFF"}`,
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
			"/experience setup                         # checkbox-style panel; no changes until you choose",
			"/experience setup save on|off             # save chat examples locally",
			"/experience setup suggest on|off          # allow habit suggestions when you ask",
			"/experience setup use-habits on|off       # use approved habits before replies",
			"/experience setup background off          # keep background learning off",
			"/experience setup status|review|help",
			"/experience on      # shortcut: resume local redacted capture",
			"/experience status  # see what is happening and the next step",
			"/experience review  # inspect review candidates if any exist",
			"/experience off     # stop capture and all runtime gates",
			"This release does not install timers or run live consolidation/model learning automatically.",
		].join("\n");
	}
	if (normalized === "review") {
		return [
			"Agent Experience review:",
			"/experience review",
			"/experience review list",
			"/experience review show <id>",
			"/experience review diff",
			"/experience review accept <id> --checksum <checksum>",
			"/experience review reject <id> --checksum <checksum>",
			"/experience review report",
			"Review keeps checksum/stale-state protection. It never auto-approves habits.",
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
	if (normalized === "advanced") {
		return [
			"Agent Experience advanced/backcompat commands:",
			"/experience capture on|off",
			"/experience consolidation on|off",
			"/experience selector on|off|calibrate",
			"/experience pending list|show|diff|accept|reject",
			"/experience habit explain <id>",
			"/experience habit accept|reject|disable|enable <id> --checksum <checksum>",
			"/experience habits report",
			"experience-consolidate is a maintainer/test CLI and still requires explicit fixture/model output.",
			"Advanced selector smart mode may call a configured model/provider; normal setup/on keeps it off.",
		].join("\n");
	}
	return [
		"Agent Experience:",
		"/experience setup                         # checkbox-style panel; no changes until you choose",
		"/experience setup save on|off             # save chat examples locally",
		"/experience setup suggest on|off          # allow habit suggestions when you ask",
		"/experience setup use-habits on|off       # use approved habits before replies",
		"/experience setup background off          # keep background learning off",
		"/experience setup status|review|help",
		"/experience on      # shortcut: resume local redacted capture",
		"/experience off     # stop capture and all runtime gates",
		"/experience status  # plain dashboard",
		"/experience review  # inspect/accept/reject candidates if any exist",
		"/experience help setup|review|advanced|troubleshoot",
		"Normal UX does not install timers, call live consolidation models, or auto-approve habits.",
	].join("\n");
}

export default function agentExperienceExtension(pi: ExtensionAPI) {
	pi.registerCommand("experience", {
		description: "Agent Experience controls: setup, on/off, status, review, and advanced capture/selector/review commands",
		handler: async (args, ctx) => {
			const tokens = String(args || "").trim().split(/\s+/).filter(Boolean);
			const [command = "status", subcommand] = tokens;
			switch (command.toLowerCase()) {
				case "status":
					await handleStatus(ctx);
					return;
				case "setup":
					await handleSetup(ctx, tokens.slice(1));
					return;
				case "on":
				case "enable":
					await handleOn(ctx);
					return;
				case "off":
				case "disable":
					await handleOff(ctx);
					return;
				case "review":
					await handleReview(tokens.slice(1), ctx);
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
					await handlePending([subcommand, ...tokens.slice(2)].filter(Boolean), ctx);
					return;
				case "habit":
					await handleHabit([subcommand, ...tokens.slice(2)].filter(Boolean), ctx);
					return;
				case "habits":
					await handleHabits([subcommand, ...tokens.slice(2)].filter(Boolean), ctx);
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
			notifyDedupedDiagnostic(ctx, selectorDiagnosticsShown, diagnosticFor("selector-runtime", error));
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
		} catch (error) {
			captureBuffer.dropKey(decision.key);
			notifyDedupedDiagnostic(ctx, captureDiagnosticsShown, diagnosticFor("capture-persist", error));
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
		} catch (error) {
			captureBuffer.dropKey(key);
			notifyDedupedDiagnostic(ctx, captureDiagnosticsShown, diagnosticFor("capture-persist", error));
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
		} catch (error) {
			captureBuffer.dropKey(key);
			notifyDedupedDiagnostic(ctx, captureDiagnosticsShown, diagnosticFor("capture-persist", error));
		}
	});
}
