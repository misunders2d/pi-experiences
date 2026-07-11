import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AgentExperiencePaths } from "../paths.ts";

export const SCHEDULED_ANALYZE_SERVICE = "pi-experiences-agent-experience-analyze.service";
export const SCHEDULED_ANALYZE_TIMER = "pi-experiences-agent-experience-analyze.timer";
export const SCHEDULED_ANALYZE_ON_CALENDAR = "*-*-* 03:30:00";

const execFileAsync = promisify(execFile);

export interface SystemdExecutor {
	(command: string, args: string[], options?: { timeout?: number }): Promise<{ stdout?: string; stderr?: string }>;
}

export interface ScheduledAnalyzeUnitContext {
	nodePath: string;
	cliPath: string;
	paths: AgentExperiencePaths;
	userId: string;
	piAgentDir: string;
	piRuntimeRoot: string;
}

export interface ScheduledAnalyzeSystemdOptions {
	executor?: SystemdExecutor;
	platform?: NodeJS.Platform;
	unitDir?: string;
	nodePath?: string;
	cliPath?: string;
	piAgentDir?: string;
	piRuntimeRoot?: string;
	expectedStateRoot?: string;
}

function defaultExecutor(command: string, args: string[], options?: { timeout?: number }) {
	return execFileAsync(command, args, { timeout: options?.timeout ?? 5_000, encoding: "utf8", maxBuffer: 64 * 1024 });
}

function unitQuote(value: string): string {
	if (/\r|\n|\0/.test(value)) throw new Error("scheduled_unit_invalid_value");
	const escaped = value.replace(/[%$\\"]/g, (character) => {
		if (character === "%") return "%%";
		if (character === "$") return "$$";
		if (character === "\\") return "\\\\";
		return '\\"';
	});
	return `"${escaped}"`;
}

function systemdConditionPath(value: string): string {
	if (!isAbsolute(value) || /[\u0000-\u001f\u007f"\\]/.test(value) || value.trimEnd() !== value) {
		throw new Error("scheduled_unit_invalid_path");
	}
	return value.replace(/%/g, "%%");
}

export function __encodeSystemdConditionPathForTest(value: string): string {
	return systemdConditionPath(value);
}

function serviceOwnsStateRoot(service: string, stateRoot: string): boolean {
	const root = resolve(stateRoot);
	return service.includes(` scheduled --root ${unitQuote(root)} --user `);
}

export function __serviceOwnsScheduledAnalyzeStateRootForTest(service: string, stateRoot: string): boolean {
	return serviceOwnsStateRoot(service, stateRoot);
}

async function assertUnitOwnership(unitDir: string, expectedStateRoot?: string): Promise<void> {
	if (!expectedStateRoot) return;
	try {
		const service = await readFile(resolve(unitDir, SCHEDULED_ANALYZE_SERVICE), "utf8");
		if (!serviceOwnsStateRoot(service, expectedStateRoot)) throw new Error("scheduled_unit_owned_by_other_state");
	} catch (error: any) {
		if (error?.code === "ENOENT") return;
		throw error;
	}
}

function defaultCliPath(): string {
	return fileURLToPath(new URL("../../../../dist/experience-consolidate.mjs", import.meta.url));
}

function defaultUnitDir(): string {
	return join(homedir(), ".config", "systemd", "user");
}

export function renderScheduledAnalyzeUnits(context: ScheduledAnalyzeUnitContext): { service: string; timer: string } {
	const service = [
		"[Unit]",
		"Description=Pi Experiences Agent Experience daily scheduled Analyze",
		"Documentation=https://github.com/misunders2d/pi-experiences#readme",
		`ConditionPathExists=${systemdConditionPath(context.paths.configPath)}`,
		"",
		"[Service]",
		"Type=oneshot",
		`ExecStart=${unitQuote(context.nodePath)} ${unitQuote(context.cliPath)} scheduled --root ${unitQuote(context.paths.root)} --user ${unitQuote(context.userId)} --pi-runtime-root ${unitQuote(context.piRuntimeRoot)}`,
		"TimeoutStartSec=150",
		"Nice=10",
		"IOSchedulingClass=best-effort",
		"IOSchedulingPriority=7",
		"NoNewPrivileges=true",
		"PrivateTmp=true",
		"ProtectSystem=strict",
		"ProtectHome=read-only",
		`ReadWritePaths=${unitQuote(context.paths.root)} ${unitQuote(context.piAgentDir)}`,
		"StandardOutput=journal",
		"StandardError=journal",
		"SyslogIdentifier=pi-experiences-analyze",
		"",
	].join("\n");
	const timer = [
		"[Unit]",
		"Description=Pi Experiences Agent Experience daily scheduled Analyze",
		"",
		"[Timer]",
		`OnCalendar=${SCHEDULED_ANALYZE_ON_CALENDAR}`,
		"Persistent=true",
		`Unit=${SCHEDULED_ANALYZE_SERVICE}`,
		"",
		"[Install]",
		"WantedBy=timers.target",
		"",
	].join("\n");
	return { service, timer };
}

async function assertRealDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("scheduled_unit_directory_invalid");
}

async function atomicWriteUnit(dir: string, name: string, content: string): Promise<void> {
	await assertRealDirectory(dir);
	const target = resolve(dir, name);
	try {
		const info = await lstat(target);
		if (!info.isFile() || info.isSymbolicLink()) throw new Error("scheduled_unit_path_invalid");
	} catch (error: any) {
		if (error?.code !== "ENOENT") throw error;
	}
	const temp = resolve(dir, `.tmp-${name}-${process.pid}-${Date.now()}`);
	const nofollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | nofollow, 0o600);
	try {
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temp, target);
	await chmod(target, 0o600);
	let directory;
	try {
		directory = await open(dir, constants.O_RDONLY);
		await directory.sync();
	} catch {
		// Best effort after atomic rename.
	} finally {
		await directory?.close().catch(() => undefined);
	}
}

async function resolveUnitContext(paths: AgentExperiencePaths, userId: string, options: ScheduledAnalyzeSystemdOptions): Promise<ScheduledAnalyzeUnitContext> {
	if ((options.platform ?? process.platform) !== "linux") throw new Error("systemd_unavailable");
	const executor = options.executor || defaultExecutor;
	try {
		await executor("systemctl", ["--user", "show-environment"], { timeout: 5_000 });
	} catch {
		throw new Error("systemd_unavailable");
	}
	let nodePath: string;
	let cliPath: string;
	let piAgentDir: string;
	let piRuntimeRoot: string;
	try {
		nodePath = await realpath(options.nodePath || process.execPath);
		cliPath = await realpath(options.cliPath || defaultCliPath());
		piAgentDir = await realpath(options.piAgentDir || join(homedir(), ".pi", "agent"));
		piRuntimeRoot = await realpath(options.piRuntimeRoot || "");
		await executor(nodePath, ["--version"], { timeout: 5_000 });
	} catch {
		throw new Error("scheduled_runtime_unavailable");
	}
	return {
		nodePath,
		cliPath,
		paths,
		userId,
		piAgentDir,
		piRuntimeRoot,
	};
}

export async function previewScheduledAnalyzeSystemd(paths: AgentExperiencePaths, userId: string, options: ScheduledAnalyzeSystemdOptions = {}): Promise<{ unitDir: string; context: ScheduledAnalyzeUnitContext; units: { service: string; timer: string } }> {
	const unitDir = resolve(options.unitDir || defaultUnitDir());
	const context = await resolveUnitContext(paths, userId, options);
	return { unitDir, context, units: renderScheduledAnalyzeUnits(context) };
}

export async function installScheduledAnalyzeSystemd(paths: AgentExperiencePaths, userId: string, options: ScheduledAnalyzeSystemdOptions = {}): Promise<{ unitDir: string; context: ScheduledAnalyzeUnitContext }> {
	const executor = options.executor || defaultExecutor;
	const unitDir = resolve(options.unitDir || defaultUnitDir());
	const context = await resolveUnitContext(paths, userId, options);
	const units = renderScheduledAnalyzeUnits(context);
	const servicePath = resolve(unitDir, SCHEDULED_ANALYZE_SERVICE);
	const timerPath = resolve(unitDir, SCHEDULED_ANALYZE_TIMER);
	const readOptional = async (path: string) => {
		try { return await readFile(path, "utf8"); } catch (error: any) { if (error?.code === "ENOENT") return undefined; throw error; }
	};
	const previousService = await readOptional(servicePath);
	const previousTimer = await readOptional(timerPath);
	if (previousService !== undefined && !serviceOwnsStateRoot(previousService, paths.root)) throw new Error("scheduled_unit_owned_by_other_state");
	let wasEnabled = false;
	try {
		await executor("systemctl", ["--user", "is-enabled", SCHEDULED_ANALYZE_TIMER], { timeout: 5_000 });
		wasEnabled = true;
	} catch {}
	await atomicWriteUnit(unitDir, SCHEDULED_ANALYZE_SERVICE, units.service);
	await atomicWriteUnit(unitDir, SCHEDULED_ANALYZE_TIMER, units.timer);
	try {
		await executor("systemctl", ["--user", "daemon-reload"], { timeout: 10_000 });
		await executor("systemctl", ["--user", "enable", "--now", SCHEDULED_ANALYZE_TIMER], { timeout: 15_000 });
	} catch {
		let rollbackIncomplete = false;
		await executor("systemctl", ["--user", "disable", "--now", SCHEDULED_ANALYZE_TIMER], { timeout: 10_000 }).catch(() => { rollbackIncomplete = true; });
		try {
			if (previousService === undefined) await rm(servicePath, { force: true });
			else await atomicWriteUnit(unitDir, SCHEDULED_ANALYZE_SERVICE, previousService);
			if (previousTimer === undefined) await rm(timerPath, { force: true });
			else await atomicWriteUnit(unitDir, SCHEDULED_ANALYZE_TIMER, previousTimer);
			await executor("systemctl", ["--user", "daemon-reload"], { timeout: 10_000 });
			if (wasEnabled && previousService !== undefined && previousTimer !== undefined) await executor("systemctl", ["--user", "enable", "--now", SCHEDULED_ANALYZE_TIMER], { timeout: 15_000 });
		} catch {
			rollbackIncomplete = true;
		}
		throw new Error(rollbackIncomplete ? "systemd_enable_failed_rollback_incomplete" : "systemd_enable_failed");
	}
	return { unitDir, context };
}

export async function disableScheduledAnalyzeSystemd(options: ScheduledAnalyzeSystemdOptions = {}): Promise<void> {
	if ((options.platform ?? process.platform) !== "linux") throw new Error("systemd_unavailable");
	const executor = options.executor || defaultExecutor;
	const unitDir = resolve(options.unitDir || defaultUnitDir());
	await assertUnitOwnership(unitDir, options.expectedStateRoot);
	try {
		try {
			await executor("systemctl", ["--user", "disable", "--now", SCHEDULED_ANALYZE_TIMER], { timeout: 15_000 });
		} catch {
			// Missing/already-disabled units are a successful disabled state. If the timer
			// is still enabled, is-enabled succeeds and the failure remains blocking.
			let stillEnabled = false;
			try {
				await executor("systemctl", ["--user", "is-enabled", SCHEDULED_ANALYZE_TIMER], { timeout: 5_000 });
				stillEnabled = true;
			} catch {}
			if (stillEnabled) throw new Error("systemd_disable_failed");
		}
		await executor("systemctl", ["--user", "daemon-reload"], { timeout: 10_000 });
	} catch {
		throw new Error("systemd_disable_failed");
	}
}

export async function removeScheduledAnalyzeSystemd(options: ScheduledAnalyzeSystemdOptions = {}): Promise<void> {
	const executor = options.executor || defaultExecutor;
	const unitDir = resolve(options.unitDir || defaultUnitDir());
	await disableScheduledAnalyzeSystemd(options);
	await rm(resolve(unitDir, SCHEDULED_ANALYZE_SERVICE), { force: true });
	await rm(resolve(unitDir, SCHEDULED_ANALYZE_TIMER), { force: true });
	try {
		await executor("systemctl", ["--user", "daemon-reload"], { timeout: 10_000 });
	} catch {
		throw new Error("systemd_remove_failed");
	}
}

export async function inspectScheduledAnalyzeSystemd(paths: AgentExperiencePaths, userId: string, options: ScheduledAnalyzeSystemdOptions = {}): Promise<{ installed: boolean; enabled: boolean; needsRepair: boolean; ownedByStateRoot: boolean; timezone: string; unitDir: string }> {
	const unitDir = resolve(options.unitDir || defaultUnitDir());
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "system local time";
	let service: string;
	let timer: string;
	try {
		service = await readFile(resolve(unitDir, SCHEDULED_ANALYZE_SERVICE), "utf8");
		timer = await readFile(resolve(unitDir, SCHEDULED_ANALYZE_TIMER), "utf8");
	} catch (error: any) {
		if (error?.code === "ENOENT") return { installed: false, enabled: false, needsRepair: false, ownedByStateRoot: false, timezone, unitDir };
		throw error;
	}
	const ownedByStateRoot = serviceOwnsStateRoot(service, paths.root);
	let needsRepair = true;
	try {
		const context = await resolveUnitContext(paths, userId, options);
		const expected = renderScheduledAnalyzeUnits(context);
		needsRepair = service !== expected.service || timer !== expected.timer;
	} catch {
		needsRepair = true;
	}
	let enabled = false;
	try {
		await (options.executor || defaultExecutor)("systemctl", ["--user", "is-enabled", SCHEDULED_ANALYZE_TIMER], { timeout: 5_000 });
		enabled = true;
	} catch {
		enabled = false;
	}
	return { installed: true, enabled, needsRepair, ownedByStateRoot, timezone, unitDir };
}
