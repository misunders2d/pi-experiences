import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPiConsolidationModelAdapter, parseProviderModel, type ConsolidationModelAdapter } from "./model-adapter.ts";
import { redactText } from "../storage/redaction.ts";

const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

type PiModelRegistry = Pick<ExtensionContext, "modelRegistry">["modelRegistry"];

type StandaloneRuntime = {
	createModelRegistry: () => Promise<PiModelRegistry>;
	completeSimple: typeof completeSimple;
};

async function validatedRuntimeRoot(input: string | undefined): Promise<string> {
	if (!input) throw new Error("pi_runtime_root_missing");
	if (!isAbsolute(input)) throw new Error("pi_runtime_root_not_absolute");
	let root: string;
	try { root = await realpath(input); } catch { throw new Error("pi_runtime_root_realpath_failed"); }
	let manifest: any;
	try { manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")); }
	catch (error: any) { throw new Error(error instanceof SyntaxError ? "pi_runtime_root_invalid_package_json" : "pi_runtime_root_missing_package_json"); }
	if (manifest?.name !== PI_CODING_AGENT_PACKAGE) throw new Error("pi_runtime_root_wrong_package");
	return root;
}

export async function loadStandalonePiRuntime(piRuntimeRoot: string | undefined): Promise<StandaloneRuntime> {
	const root = await validatedRuntimeRoot(piRuntimeRoot);
	const codingAgentUrl = pathToFileURL(join(root, "dist", "index.js")).href;
	const compatUrl = pathToFileURL(join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "compat.js")).href;
	let codingAgent: any;
	let compat: any;
	try { codingAgent = await import(codingAgentUrl); } catch { throw new Error("pi_runtime_root_import_failed"); }
	try { compat = await import(compatUrl); } catch { throw new Error("pi_runtime_compat_import_failed"); }
	if (typeof compat?.completeSimple !== "function") throw new Error("pi_runtime_compat_missing_api");
	if (typeof codingAgent?.ModelRuntime?.create === "function" && typeof codingAgent?.ModelRegistry === "function") {
		return {
			createModelRegistry: async () => new codingAgent.ModelRegistry(await codingAgent.ModelRuntime.create()),
			completeSimple: compat.completeSimple,
		};
	}
	if (typeof codingAgent?.AuthStorage?.create === "function" && typeof codingAgent?.ModelRegistry?.create === "function") {
		return {
			createModelRegistry: async () => codingAgent.ModelRegistry.create(codingAgent.AuthStorage.create()),
			completeSimple: compat.completeSimple,
		};
	}
	throw new Error("pi_runtime_root_missing_coding_agent_api");
}

export async function validateStandaloneConsolidationModel(configured: string, piRuntimeRoot: string): Promise<{ ok: true } | { ok: false; reason: string }> {
	const parsed = parseProviderModel(configured);
	if (!parsed) return { ok: false, reason: "invalid provider/model id" };
	try {
		const runtime = await loadStandalonePiRuntime(piRuntimeRoot);
		const modelRegistry = await runtime.createModelRegistry();
		const model = modelRegistry.find(parsed.provider, parsed.modelId);
		if (!model) return { ok: false, reason: "model is unavailable to the standalone scheduler" };
		if (!modelRegistry.hasConfiguredAuth(model)) return { ok: false, reason: "model authentication is not configured" };
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) return { ok: false, reason: "model authentication is unavailable" };
		return { ok: true };
	} catch (error: any) {
		return { ok: false, reason: redactText(String(error?.message || error)).slice(0, 180) };
	}
}

export async function createStandaloneConsolidationModelAdapter(options: { piRuntimeRoot: string; signal?: AbortSignal }): Promise<ConsolidationModelAdapter> {
	const runtime = await loadStandalonePiRuntime(options.piRuntimeRoot);
	const modelRegistry = await runtime.createModelRegistry();
	return createPiConsolidationModelAdapter(
		{ modelRegistry, signal: options.signal } as Pick<ExtensionContext, "modelRegistry" | "signal">,
		{ complete: runtime.completeSimple, purpose: "agent-experience-scheduled-habit-learning" },
	);
}
