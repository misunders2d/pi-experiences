import { Box, SettingsList, Text, type Component, type SettingItem, type SettingsListTheme } from "@earendil-works/pi-tui";

export type SetupView = "home" | "learning" | "guidance" | "habits" | "automation" | "status";

export type SetupAction =
	| "openLearning"
	| "openGuidance"
	| "openHabits"
	| "openAutomation"
	| "openStatus"
	| "capture"
	| "learningModel"
	| "analyze"
	| "review"
	| "advisor"
	| "advisorModel"
	| "selector"
	| "assessmentModel"
	| "habits"
	| "duplicates"
	| "embedding"
	| "retention"
	| "schedule"
	| "breakIn"
	| "semanticFiles"
	| "off"
	| "back"
	| "done";

export interface SetupConfigSnapshot {
	enabled: boolean;
	advisor_enabled: boolean;
	advisor_model: string;
	capture_enabled: boolean;
	consolidation_enabled: boolean;
	consolidation_model: string;
	selector_enabled: boolean;
	selector_model: string;
	embedding_enabled: boolean;
	observation_retention_days: number;
	timer_enabled: boolean;
	break_in_enabled: boolean;
}

export interface SetupSnapshot {
	host: "pi" | "omp";
	config: SetupConfigSnapshot;
	counts: {
		observations: number;
		approved: number;
		suggestions: number;
		duplicates: number;
		advisorQueued?: number;
	};
	semanticFiles: "Ready" | "Not prepared" | "Needs attention";
	reviewState?: "Ready" | "Needs attention";
	effectiveAdvisorModel: string;
	advisorRuntime?: "Active" | "Paused" | "Needs attention";
}

const RESET = "\x1b[0m";
const PANEL_BG = "\x1b[48;5;235m";
const FG_ACCENT = "\x1b[38;5;81m";
const FG_DIM = "\x1b[38;5;245m";
const FG_WARN = "\x1b[38;5;220m";
const BOLD = "\x1b[1m";

function style(text: string, ...codes: string[]): string {
	return `${codes.join("")}${text}${RESET}${PANEL_BG}`;
}

function panelBg(text: string): string {
	return `${PANEL_BG}${text}${RESET}`;
}

function checkboxValue(value: boolean): string {
	return value ? "[x] ON" : "[ ] OFF";
}

const setupSettingsTheme: SettingsListTheme = {
	cursor: style("→ ", FG_ACCENT, BOLD),
	label: (text, selected) => selected ? style(text, FG_ACCENT, BOLD) : text,
	value: (text, selected) => selected ? style(text, FG_WARN, BOLD) : text,
	description: (text) => style(text, FG_DIM),
	hint: (text) => style(text, FG_DIM),
};

function actionItem(id: SetupAction, label: string, currentValue = "", description = ""): SettingItem {
	return { id, label, currentValue, values: [currentValue], description };
}

function active(config: SetupConfigSnapshot, feature: boolean): boolean {
	return config.enabled && feature;
}

export function buildSetupItems(view: SetupView, snapshot: SetupSnapshot): SettingItem[] {
	const { config, counts } = snapshot;
	const reviewAvailable = snapshot.reviewState !== "Needs attention";
	if (view === "home") {
		const guidanceValue = snapshot.host === "omp"
			? `OMP Advisor context ${active(config, config.advisor_enabled) ? "ON" : "OFF"} · habits ${active(config, config.selector_enabled) ? "ON" : "OFF"}`
			: `Advisor ${active(config, config.advisor_enabled) ? "ON" : "OFF"} · habits ${active(config, config.selector_enabled) ? "ON" : "OFF"}`;
		return [
			actionItem("openLearning", "Learning from conversations", active(config, config.capture_enabled) ? "ON" : "OFF", "Save examples, choose the learning model, Analyze, and review suggestions."),
			actionItem("openGuidance", "Guidance and Advisor", guidanceValue, snapshot.host === "omp" ? "Connect approved Experiences to OMP's native Advisor or apply habits directly." : "Configure independent runtime review and approved-habit guidance."),
			actionItem("openHabits", "Manage habits", reviewAvailable ? `${counts.approved} approved · ${counts.suggestions} waiting` : "Needs attention", "Review approved habits and resolve possible duplicates."),
			actionItem("openAutomation", "Automation and privacy", `${config.timer_enabled ? "Scheduled" : "Manual"} · ${config.observation_retention_days}-day retention`, "Manage retention, review prompts, schedule, and shared local files."),
			actionItem("openStatus", "Status and help", "", "See grouped status and concise explanations."),
			actionItem("off", "Turn everything off", "", "Disable runtime features while preserving records and local files."),
			actionItem("done", "Done", "", "Close setup."),
		];
	}
	if (view === "learning") {
		return [
			actionItem("capture", "Learn from conversations", checkboxValue(active(config, config.capture_enabled)), "Save bounded, redacted completed conversation examples locally. Suggestions always wait for review."),
			actionItem("learningModel", "Habit-learning model", config.consolidation_model || "choose model", "Choose the authenticated model used by Analyze."),
			actionItem("analyze", "Analyze waiting examples", `${counts.observations} waiting`, "Create suggestions for review; nothing is auto-approved."),
			actionItem("review", "Review suggested habits", reviewAvailable ? `${counts.suggestions} waiting` : "Needs attention", "Approve or reject each suggestion explicitly."),
			actionItem("back", "Back"),
		];
	}
	if (view === "guidance") {
		const advisorItems = snapshot.host === "omp"
			? [
				actionItem("advisor", "Use Experiences in OMP Advisor", checkboxValue(active(config, config.advisor_enabled)), "Supply bounded approved context to OMP's native Advisor. This does not create a second Advisor or model call."),
			]
			: [
				actionItem("advisor", "Runtime Advisor", checkboxValue(active(config, config.advisor_enabled)), "Review transcript updates and show visible guidance after explicit setup."),
				actionItem("advisorModel", "Advisor model", config.advisor_model ? snapshot.effectiveAdvisorModel : "Same as habit assessment", "Inherit the habit-assessment model or choose a separate authenticated model."),
			];
		return [
			...advisorItems,
			actionItem("selector", "Use approved habits", checkboxValue(active(config, config.selector_enabled)), "Apply only human-approved habits directly before replies; this is independent from Advisor context."),
			actionItem("assessmentModel", "Habit-assessment model", config.selector_model || "choose model", "Choose the authenticated model that checks whether approved habits apply."),
			actionItem("back", "Back"),
		];
	}
	if (view === "habits") {
		return [
			actionItem("habits", "Review approved habits", reviewAvailable ? String(counts.approved) : "Needs attention", "Inspect, disable, re-enable, or archive an approved habit."),
			actionItem("duplicates", "Resolve possible duplicates", reviewAvailable ? `${counts.duplicates} waiting` : "Needs attention", "Review each possible duplicate before any change."),
			actionItem("embedding", "Prevent duplicate habits", checkboxValue(active(config, config.embedding_enabled)), "Compare habit wording locally and route possible matches for review."),
			actionItem("back", "Back"),
		];
	}
	if (view === "automation") {
		return [
			actionItem("retention", "Keep analyzed source examples", `${config.observation_retention_days} days`, "Choose short private retention for rotated redacted source text."),
			actionItem("schedule", "Automatic Analyze schedule", config.timer_enabled ? "ON" : "OFF", "Inspect or explicitly manage the local daily Analyze schedule."),
			actionItem("breakIn", "Review prompts after Analyze", checkboxValue(active(config, config.break_in_enabled)), "Offer a private review prompt only after Analyze creates suggestions."),
			actionItem("semanticFiles", "Local semantic files", snapshot.semanticFiles, "Explain, verify, or explicitly remove files shared by approved-habit guidance and duplicate prevention."),
			actionItem("back", "Back"),
		];
	}
	return [actionItem("back", "Back")];
}

export function buildFallbackSetupOptions(view: SetupView, snapshot: SetupSnapshot): string[] {
	return buildSetupItems(view, snapshot).map((item) => {
		const value = item.currentValue === "[x] ON" ? "ON" : item.currentValue === "[ ] OFF" ? "OFF" : item.currentValue;
		return value ? `${item.label}: ${value}` : item.label;
	});
}

export function setupActionForFallbackOption(view: SetupView, snapshot: SetupSnapshot, option: string): SetupAction | undefined {
	const items = buildSetupItems(view, snapshot);
	const index = buildFallbackSetupOptions(view, snapshot).indexOf(option);
	return index < 0 ? undefined : items[index]?.id as SetupAction | undefined;
}

function viewTitle(view: SetupView): string {
	if (view === "home") return "Agent Experience setup";
	if (view === "learning") return "Learning from conversations";
	if (view === "guidance") return "Guidance and Advisor";
	if (view === "habits") return "Manage habits";
	if (view === "automation") return "Automation and privacy";
	return "Status and help";
}

function statusLines(snapshot: SetupSnapshot): string[] {
	const { config, counts } = snapshot;
	const reviewAvailable = snapshot.reviewState !== "Needs attention";
	const advisorModel = config.advisor_model ? snapshot.effectiveAdvisorModel : `${snapshot.effectiveAdvisorModel} (same as habit assessment)`;
	const advisorLifecycle = snapshot.advisorRuntime ? ` · runtime ${snapshot.advisorRuntime}` : "";
	const advisorQueue = typeof counts.advisorQueued === "number" ? ` · ${counts.advisorQueued} queued` : "";
	const advisorLines = snapshot.host === "omp"
		? [
			`OMP Advisor context — ${active(config, config.advisor_enabled) ? "ON" : "OFF"} · native Advisor settings stay in OMP`,
			"Agent Experience supplies bounded approved context to OMP's existing Advisor; it does not create another reviewer or model call.",
		]
		: [
			`Advisor — ${active(config, config.advisor_enabled) ? "ON" : "OFF"} · ${advisorModel}${advisorLifecycle}${advisorQueue}`,
			"Advisor reviews transcript updates with a separate authenticated model and shows any steering visibly.",
		];
	return [
		`Learning — ${active(config, config.capture_enabled) ? "ON" : "OFF"} · ${config.consolidation_model} · ${counts.observations} waiting examples · ${reviewAvailable ? `${counts.suggestions} suggestions waiting` : "suggestions need attention"}`,
		"Learning saves redacted completed examples locally; suggestions always wait for review.",
		...advisorLines,
		`Approved-habit guidance — ${active(config, config.selector_enabled) ? "ON" : "OFF"} · ${config.selector_model}`,
		"Approved-habit guidance uses only habits you approved and remains independent from Advisor.",
		reviewAvailable ? `Habits — ${counts.approved} approved · ${counts.suggestions} waiting · ${counts.duplicates} possible duplicates` : "Habits — Needs attention",
		`Privacy and automation — ${config.observation_retention_days}-day retention · schedule ${config.timer_enabled ? "ON" : "OFF"} · review prompts ${active(config, config.break_in_enabled) ? "ON" : "OFF"}`,
		`Local semantic files — ${snapshot.semanticFiles}`,
	];
}

export class SetupSettingsComponent implements Component {
	private readonly box: Box;
	private readonly list: SettingsList;

	constructor(view: SetupView, snapshot: SetupSnapshot, done: (result: SetupAction | undefined) => void) {
		this.box = new Box(2, 1, panelBg);
		this.box.addChild(new Text(style(viewTitle(view), FG_ACCENT, BOLD), 0, 0));
		this.box.addChild(new Text(style(view === "home" ? "Space/Enter opens a group. Esc closes setup." : "Space/Enter toggles or opens a row. Esc returns to setup home.", FG_DIM), 0, 0));
		if (view === "status") {
			this.box.addChild({ render: () => [""], invalidate() {} });
			for (const line of statusLines(snapshot)) this.box.addChild(new Text(line, 0, 0));
		}
		this.box.addChild({ render: () => [""], invalidate() {} });
		this.list = new SettingsList(buildSetupItems(view, snapshot), 15, setupSettingsTheme, (id) => done(id as SetupAction), () => done(view === "home" ? "done" : "back"), { enableSearch: false });
		this.box.addChild(this.list);
	}

	render(width: number): string[] { return this.box.render(width); }
	handleInput(data: string): void { this.list.handleInput(data); }
	invalidate(): void { this.box.invalidate(); }
}

interface SetupUiContext {
	hasUI?: boolean;
	ui?: {
		custom?: (
			factory: (
				tui: unknown,
				theme: unknown,
				keybindings: unknown,
				done: (value: SetupAction | undefined) => void,
			) => Component,
			options: {
				overlay: boolean;
				overlayOptions: { width: string; minWidth: number; maxHeight: string; anchor: string; margin: number };
			},
		) => Promise<SetupAction | undefined> | SetupAction | undefined;
		select?: (title: string, options: string[]) => Promise<string | undefined> | string | undefined;
		notify?: (message: string, level: "info") => void;
	};
}

export async function showSetupView(ctx: unknown, view: SetupView, snapshot: SetupSnapshot): Promise<SetupAction | undefined> {
	if (!ctx || typeof ctx !== "object") return undefined;
	const context = ctx as SetupUiContext;
	const custom = context.ui?.custom;
	if (context.hasUI !== false && typeof custom === "function") {
		return custom((_: unknown, _theme: unknown, _keybindings: unknown, done: (value: SetupAction | undefined) => void) => new SetupSettingsComponent(view, snapshot, done), {
			overlay: true,
			overlayOptions: { width: "80%", minWidth: 72, maxHeight: "90%", anchor: "center", margin: 1 },
		});
	}
	const select = context.ui?.select;
	if (context.hasUI === false || typeof select !== "function") return undefined;
	if (view === "status") context.ui?.notify?.(statusLines(snapshot).join("\n"), "info");
	const options = buildFallbackSetupOptions(view, snapshot);
	const choice = await select(`${viewTitle(view)} — choose what to configure`, options);
	if (!choice) return view === "home" ? "done" : "back";
	return setupActionForFallbackOption(view, snapshot, choice);
}
