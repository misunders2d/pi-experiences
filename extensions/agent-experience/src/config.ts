export interface AgentExperienceConfig {
	enabled: boolean;
	capture_enabled: boolean;
	selector_enabled: boolean;
	embedding_enabled: boolean;
	consolidation_enabled: boolean;
	observation_retention_days: number;
	analyze_batch_max_records: number;
	analyze_batch_max_bytes: number;
	timer_enabled: boolean;
	break_in_enabled: boolean;
	selector_mode: "instant" | "smart";
	selector_model: string;
	selector_timeout_ms: number;
	selector_min_confidence_bp: number;
	selector_min_overlap_score: number;
	selector_max_habits: number;
	selector_staleness_max: number;
	consolidation_model: string;
	law_path: string;
}

export const DEFAULT_AGENT_EXPERIENCE_CONFIG: AgentExperienceConfig = Object.freeze({
	enabled: false,
	capture_enabled: false,
	selector_enabled: false,
	embedding_enabled: false,
	consolidation_enabled: false,
	observation_retention_days: 7,
	analyze_batch_max_records: 200,
	analyze_batch_max_bytes: 80000,
	timer_enabled: false,
	break_in_enabled: false,
	selector_mode: "instant",
	selector_model: "openai-codex/gpt-5.4-mini",
	selector_timeout_ms: 20000,
	selector_min_confidence_bp: 7500,
	selector_min_overlap_score: 1,
	selector_max_habits: 3,
	selector_staleness_max: 0.8,
	consolidation_model: "openai-codex/gpt-5.5",
	law_path: "law.md",
});

const BOOLEAN_KEYS = new Set<keyof AgentExperienceConfig>([
	"enabled",
	"capture_enabled",
	"selector_enabled",
	"embedding_enabled",
	"consolidation_enabled",
	"timer_enabled",
	"break_in_enabled",
]);

const NUMBER_KEYS = new Set<keyof AgentExperienceConfig>([
	"selector_timeout_ms",
	"selector_min_confidence_bp",
	"selector_min_overlap_score",
	"selector_max_habits",
	"selector_staleness_max",
	"observation_retention_days",
	"analyze_batch_max_records",
	"analyze_batch_max_bytes",
]);

function parseTomlScalar(raw: string): string | number | boolean | undefined {
	const value = raw.trim();
	if (value === "true") return true;
	if (value === "false") return false;
	if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
	const quoted = value.match(/^"(.*)"$/);
	if (quoted) return quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	return undefined;
}

const SECTION_KEY_MAP: Record<string, keyof AgentExperienceConfig> = {
	"selector.mode": "selector_mode",
	"selector.model": "selector_model",
	"selector.timeout_ms": "selector_timeout_ms",
	"selector.min_confidence_bp": "selector_min_confidence_bp",
	"selector.min_overlap_score": "selector_min_overlap_score",
	"selector.max_habits": "selector_max_habits",
	"selector.staleness_max": "selector_staleness_max",
};

const ENV_KEY_MAP: Record<string, keyof AgentExperienceConfig> = {
	AX_SELECTOR_MODE: "selector_mode",
	AX_SELECTOR_MODEL: "selector_model",
	AX_SELECTOR_TIMEOUT_MS: "selector_timeout_ms",
	AX_SELECTOR_MIN_OVERLAP_SCORE: "selector_min_overlap_score",
};

function normalizeConfigKey(raw: string, section: string | undefined): keyof AgentExperienceConfig | undefined {
	const dotted = raw.includes(".") ? raw : (section ? `${section}.${raw}` : raw);
	const mapped = SECTION_KEY_MAP[dotted] || raw;
	return mapped in DEFAULT_AGENT_EXPERIENCE_CONFIG ? mapped as keyof AgentExperienceConfig : undefined;
}

function applyConfigValue(config: AgentExperienceConfig, key: keyof AgentExperienceConfig, parsed: string | number | boolean | undefined): void {
	if (key === "observation_retention_days" && typeof parsed === "number" && [7, 14, 30].includes(Math.trunc(parsed))) config.observation_retention_days = Math.trunc(parsed);
	else if (key === "analyze_batch_max_records" && typeof parsed === "number" && Number.isFinite(parsed)) config.analyze_batch_max_records = Math.max(1, Math.min(500, Math.trunc(parsed)));
	else if (key === "analyze_batch_max_bytes" && typeof parsed === "number" && Number.isFinite(parsed)) config.analyze_batch_max_bytes = Math.max(65537, Math.min(2000000, Math.trunc(parsed)));
	else if (BOOLEAN_KEYS.has(key) && typeof parsed === "boolean") (config as any)[key] = parsed;
	else if (NUMBER_KEYS.has(key) && typeof parsed === "number" && Number.isFinite(parsed)) (config as any)[key] = parsed;
	else if (key === "selector_mode" && (parsed === "instant" || parsed === "smart")) (config as any)[key] = parsed;
	else if (!BOOLEAN_KEYS.has(key) && !NUMBER_KEYS.has(key) && key !== "selector_mode" && typeof parsed === "string") (config as any)[key] = parsed;
}

export function applyAgentExperienceEnvOverrides(config: AgentExperienceConfig, env: NodeJS.ProcessEnv = process.env): AgentExperienceConfig {
	const out: AgentExperienceConfig = { ...config };
	for (const [envKey, key] of Object.entries(ENV_KEY_MAP)) {
		if (env[envKey] === undefined) continue;
		applyConfigValue(out, key, parseTomlScalar(String(env[envKey])) ?? String(env[envKey]));
	}
	return out;
}

export function parseAgentExperienceConfig(text: string, env?: NodeJS.ProcessEnv): AgentExperienceConfig {
	const config: AgentExperienceConfig = { ...DEFAULT_AGENT_EXPERIENCE_CONFIG };
	let section: string | undefined;
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.replace(/#.*/, "").trim();
		if (!trimmed) continue;
		const sectionMatch = trimmed.match(/^\[([A-Za-z0-9_.-]+)\]$/);
		if (sectionMatch) { section = sectionMatch[1]; continue; }
		const match = trimmed.match(/^([A-Za-z0-9_.]+)\s*=\s*(.+)$/);
		if (!match) continue;
		const key = normalizeConfigKey(match[1], section);
		if (!key) continue;
		applyConfigValue(config, key, parseTomlScalar(match[2]));
	}
	return applyAgentExperienceEnvOverrides(config, env ?? {});
}

function quote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function formatAgentExperienceConfig(config: AgentExperienceConfig): string {
	const merged = { ...DEFAULT_AGENT_EXPERIENCE_CONFIG, ...config };
	return [
		"# Agent Experience config",
		"# Safe defaults: master/capture/selector/timer start disabled unless explicit commands edit this file.",
		`enabled = ${merged.enabled}`,
		`capture_enabled = ${merged.capture_enabled}`,
		`selector_enabled = ${merged.selector_enabled}`,
		`embedding_enabled = ${merged.embedding_enabled}`,
		`consolidation_enabled = ${merged.consolidation_enabled}`,
		`timer_enabled = ${merged.timer_enabled}`,
		`break_in_enabled = ${merged.break_in_enabled}`,
		// selector_mode and selector_min_overlap_score remain readable for old
		// configs but are intentionally not rewritten. All steering now requires
		// mandatory local vectors followed by the bounded applicability judge.
		`selector_model = ${quote(merged.selector_model)}`,
		`selector_timeout_ms = ${merged.selector_timeout_ms}`,
		`selector_min_confidence_bp = ${Math.trunc(merged.selector_min_confidence_bp)}`,
		`selector_max_habits = ${Math.trunc(merged.selector_max_habits)}`,
		`selector_staleness_max = ${merged.selector_staleness_max}`,
		`consolidation_model = ${quote(merged.consolidation_model)}`,
		`observation_retention_days = ${[7, 14, 30].includes(Math.trunc(merged.observation_retention_days)) ? Math.trunc(merged.observation_retention_days) : 7}`,
		`analyze_batch_max_records = ${Math.max(1, Math.min(500, Math.trunc(merged.analyze_batch_max_records)))}`,
		`analyze_batch_max_bytes = ${Math.max(65537, Math.min(2000000, Math.trunc(merged.analyze_batch_max_bytes)))}`,
		`law_path = ${quote(merged.law_path)}`,
		"",
	].join("\n");
}

export function summarizeAgentExperienceConfig(config: AgentExperienceConfig, configPath: string, exists: boolean): string {
	const lines = [
		`Agent Experience: ${config.enabled ? "enabled" : "disabled"}`,
		`config: ${configPath}${exists ? "" : " (not created; using defaults)"}`,
		`capture=${config.capture_enabled}`,
		`selector=${config.selector_enabled} method=local_vectors_plus_bounded_judge timeout_ms=${config.selector_timeout_ms} min_confidence_bp=${config.selector_min_confidence_bp} max_habits=${config.selector_max_habits}`,
		`selector: local condition-vector retrieval is mandatory; one bounded ${config.selector_model} applicability call follows retrieval and failures produce no guidance`,
		`duplicate_prevention=${config.embedding_enabled ? "enabled_local" : "disabled"}`,
		`consolidation=${config.consolidation_enabled} analyze_batch_max_records=${config.analyze_batch_max_records} analyze_batch_max_bytes=${config.analyze_batch_max_bytes}`,
		`observation_retention_days=${config.observation_retention_days}`,
		`law_path=${config.law_path} (relative paths resolve under state root)`,
		`timer=${config.timer_enabled}`,
		`break_in=${config.break_in_enabled} review_only=true`,
		"Selector remains disabled unless master enabled and selector_enabled=true; selector activation requires the configured law file.",
	];
	return lines.join("\n");
}
