import { chmod, lstat, mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { constants } from "node:fs";
import {
	DEFAULT_AGENT_EXPERIENCE_CONFIG,
	applyAgentExperienceEnvOverrides,
	formatAgentExperienceConfig,
	parseAgentExperienceConfig,
	type AgentExperienceConfig,
} from "./config.ts";

export interface AgentExperiencePaths {
	root: string;
	configPath: string;
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

export function getAgentExperiencePaths(env: NodeJS.ProcessEnv = process.env): AgentExperiencePaths {
	const configuredRoot = env.AX_STATE_ROOT || env.AGENT_EXPERIENCE_ROOT || "~/.agents/experience";
	const root = resolve(expandHome(configuredRoot));
	return { root, configPath: join(root, "agent-experience.toml") };
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error: any) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

export async function readAgentExperienceConfig(paths = getAgentExperiencePaths()): Promise<{ config: AgentExperienceConfig; exists: boolean; path: string }> {
	if (!(await exists(paths.configPath))) {
		return { config: applyAgentExperienceEnvOverrides({ ...DEFAULT_AGENT_EXPERIENCE_CONFIG }, process.env), exists: false, path: paths.configPath };
	}
	await assertRegularConfigFile(paths.configPath);
	const text = await readFile(paths.configPath, "utf8");
	return { config: parseAgentExperienceConfig(text, process.env), exists: true, path: paths.configPath };
}

async function ensurePrivateRoot(root: string): Promise<void> {
	await mkdir(root, { recursive: true, mode: 0o700 });
	const info = await lstat(root);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Agent Experience private root is not a real directory");
	await chmod(root, 0o700);
}

async function assertRegularConfigFile(path: string): Promise<void> {
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink()) throw new Error("Agent Experience config is not a regular private file");
	} catch (error: any) {
		if (error?.code === "ENOENT") return;
		throw error;
	}
}

export async function writeAgentExperienceConfig(config: AgentExperienceConfig, paths = getAgentExperiencePaths()): Promise<void> {
	await ensurePrivateRoot(paths.root);
	await mkdir(dirname(paths.configPath), { recursive: true, mode: 0o700 });
	await assertRegularConfigFile(paths.configPath);
	const nofollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const handle = await open(paths.configPath, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | nofollow, 0o600);
	try {
		await handle.writeFile(formatAgentExperienceConfig(config), "utf8");
	} finally {
		await handle.close();
	}
	await chmod(paths.configPath, 0o600);
}

export async function setAgentExperienceEnabled(enabled: boolean, paths = getAgentExperiencePaths()): Promise<{ config: AgentExperienceConfig; path: string }> {
	const current = await readAgentExperienceConfig(paths);
	const config = {
		...DEFAULT_AGENT_EXPERIENCE_CONFIG,
		...current.config,
		enabled,
		// Disabling the master switch always drops feature flags. Enabling the master switch
		// does not implicitly enable capture or any future runtime behavior.
		capture_enabled: enabled ? current.config.capture_enabled : false,
		selector_enabled: false,
		embedding_enabled: false,
		consolidation_enabled: false,
		timer_enabled: false,
		break_in_enabled: false,
	};
	await writeAgentExperienceConfig(config, paths);
	return { config, path: paths.configPath };
}

export async function setAgentExperienceSimpleOn(paths = getAgentExperiencePaths()): Promise<{ config: AgentExperienceConfig; path: string }> {
	const current = await readAgentExperienceConfig(paths);
	const config = {
		...DEFAULT_AGENT_EXPERIENCE_CONFIG,
		...current.config,
		enabled: true,
		capture_enabled: true,
		// Simple on/setup is intentionally capture-only in this release. These gates stay off
		// because there is no bundled scheduled/live learning adapter or package-owned timer;
		// on-demand analysis is available from the /experience setup menu.
		selector_enabled: false,
		embedding_enabled: false,
		consolidation_enabled: false,
		timer_enabled: false,
		break_in_enabled: false,
	};
	await writeAgentExperienceConfig(config, paths);
	return { config, path: paths.configPath };
}

export async function setAgentExperienceCaptureEnabled(captureEnabled: boolean, paths = getAgentExperiencePaths()): Promise<{ config: AgentExperienceConfig; path: string }> {
	const current = await readAgentExperienceConfig(paths);
	const config = {
		...DEFAULT_AGENT_EXPERIENCE_CONFIG,
		...current.config,
		capture_enabled: captureEnabled,
	};
	await writeAgentExperienceConfig(config, paths);
	return { config, path: paths.configPath };
}

export async function setAgentExperienceCaptureActive(captureActive: boolean, paths = getAgentExperiencePaths()): Promise<{ config: AgentExperienceConfig; path: string }> {
	const current = await readAgentExperienceConfig(paths);
	const enablesMaster = captureActive && !current.config.enabled;
	const config = {
		...DEFAULT_AGENT_EXPERIENCE_CONFIG,
		...current.config,
		enabled: captureActive ? true : current.config.enabled,
		capture_enabled: captureActive,
		// If capture has to enable the master switch, do not accidentally make a stale
		// selector/guidance flag effective. Guidance remains an explicit toggle.
		selector_enabled: enablesMaster ? false : current.config.selector_enabled,
	};
	await writeAgentExperienceConfig(config, paths);
	return { config, path: paths.configPath };
}

export async function setAgentExperienceConsolidationEnabled(consolidationEnabled: boolean, paths = getAgentExperiencePaths()): Promise<{ config: AgentExperienceConfig; path: string }> {
	const current = await readAgentExperienceConfig(paths);
	const config = {
		...DEFAULT_AGENT_EXPERIENCE_CONFIG,
		...current.config,
		consolidation_enabled: consolidationEnabled,
		// Timer/model automation remains a separate future gate.
		timer_enabled: false,
		break_in_enabled: false,
	};
	await writeAgentExperienceConfig(config, paths);
	return { config, path: paths.configPath };
}

export async function setAgentExperienceConsolidationModel(model: string, paths = getAgentExperiencePaths()): Promise<{ config: AgentExperienceConfig; path: string }> {
	const current = await readAgentExperienceConfig(paths);
	const config = {
		...DEFAULT_AGENT_EXPERIENCE_CONFIG,
		...current.config,
		consolidation_model: model,
		consolidation_enabled: true,
		// Choosing a model enables manual learning only. Timer/break-in remain separate gates.
		timer_enabled: false,
		break_in_enabled: false,
	};
	await writeAgentExperienceConfig(config, paths);
	return { config, path: paths.configPath };
}

export async function setAgentExperienceTimerEnabled(timerEnabled: boolean, paths = getAgentExperiencePaths()): Promise<{ config: AgentExperienceConfig; path: string }> {
	const current = await readAgentExperienceConfig(paths);
	const config = {
		...DEFAULT_AGENT_EXPERIENCE_CONFIG,
		...current.config,
		// Enabling package-owned timers is not supported yet; fail closed to disabled.
		timer_enabled: timerEnabled ? false : false,
		break_in_enabled: false,
	};
	await writeAgentExperienceConfig(config, paths);
	return { config, path: paths.configPath };
}

export async function setAgentExperienceSelectorEnabled(selectorEnabled: boolean, paths = getAgentExperiencePaths()): Promise<{ config: AgentExperienceConfig; path: string }> {
	const current = await readAgentExperienceConfig(paths);
	const config = {
		...DEFAULT_AGENT_EXPERIENCE_CONFIG,
		...current.config,
		selector_enabled: selectorEnabled,
	};
	await writeAgentExperienceConfig(config, paths);
	return { config, path: paths.configPath };
}

export async function setAgentExperienceEmbeddingOptIn(optIn: boolean, paths = getAgentExperiencePaths()): Promise<{ config: AgentExperienceConfig; path: string }> {
	const current = await readAgentExperienceConfig(paths);
	const config = {
		...DEFAULT_AGENT_EXPERIENCE_CONFIG,
		...current.config,
		embedding_openai_compatible_opt_in: optIn,
		...(optIn ? {} : { embedding_enabled: false }),
	};
	await writeAgentExperienceConfig(config, paths);
	return { config, path: paths.configPath };
}

export async function setAgentExperienceEmbeddingEnabledAfterScan(enabled: boolean, paths = getAgentExperiencePaths()): Promise<{ config: AgentExperienceConfig; path: string }> {
	const current = await readAgentExperienceConfig(paths);
	const config = {
		...DEFAULT_AGENT_EXPERIENCE_CONFIG,
		...current.config,
		embedding_enabled: enabled,
	};
	await writeAgentExperienceConfig(config, paths);
	return { config, path: paths.configPath };
}

export async function setAgentExperienceEmbeddingThresholdsAfterScan(input: { reviewThresholdBp: number; strongThresholdBp: number }, paths = getAgentExperiencePaths()): Promise<{ config: AgentExperienceConfig; path: string }> {
	const current = await readAgentExperienceConfig(paths);
	const review = Math.max(0, Math.min(10000, Math.trunc(input.reviewThresholdBp)));
	const strong = Math.max(review, Math.min(10000, Math.trunc(input.strongThresholdBp)));
	const config = {
		...DEFAULT_AGENT_EXPERIENCE_CONFIG,
		...current.config,
		embedding_review_threshold_bp: review,
		embedding_strong_threshold_bp: strong,
	};
	await writeAgentExperienceConfig(config, paths);
	return { config, path: paths.configPath };
}
