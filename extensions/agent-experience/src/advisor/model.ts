import {
	Agent,
	estimateTokens as estimateAgentMessageTokens,
	type AgentMessage,
	type AgentOptions,
	type AgentTool,
} from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as piStreamSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildAdvisorSystemPrompt, formatAdvisorUpdate } from "./prompt.ts";
import { AdvisorAttemptBuffer, createAdvisorEmissionTools } from "./tools.ts";
import type { AdvisorAttempt, AdvisorDiagnosticReason, AdvisorUpdate } from "./types.ts";
import { createAdvisorWorkspaceBudget, createAdvisorWorkspaceTools } from "./workspace-tools.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RETIRED_AGENTS = 4;
const REVIEW_FAILURE_REASONS = new Set<AdvisorDiagnosticReason>([
	"advisor_auth_unavailable",
	"advisor_context_overflow",
	"advisor_timeout",
	"advisor_unavailable",
]);

function reviewFailure(reason: AdvisorDiagnosticReason): never {
	throw new Error(reason);
}

type RequestAuth = {
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
};

interface AgentAuthState {
	current?: RequestAuth;
}

type AdvisorAgentInstance = {
	state: {
		systemPrompt: string;
		model: Model<any>;
		tools: AgentTool[];
		messages: AgentMessage[];
		errorMessage?: string;
	};
	prompt(input: string): Promise<void>;
	abort(): void;
	reset(): void;
	waitForIdle(): Promise<void>;
};

export interface AdvisorAgentAdapter {
	review(update: AdvisorUpdate, signal?: AbortSignal): Promise<AdvisorAttempt[]>;
	reset(): void;
	dispose(): Promise<void>;
	readonly contextTokenEstimate: number;
}

export interface PiAdvisorAgentAdapterInput {
	cwd: string;
	model: string;
	sharedInstructions?: string;
	timeoutMs?: number;
	agentFactory?: (options: AgentOptions) => AdvisorAgentInstance;
	streamSimple?: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
	estimateTokens?: (message: AgentMessage) => number;
}

function parseProviderModel(value: string): { provider: string; modelId: string } | undefined {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash !== value.lastIndexOf("/")) return undefined;
	const provider = value.slice(0, slash);
	const modelId = value.slice(slash + 1);
	if (!provider || !modelId || provider.includes("..") || modelId.includes("..")) return undefined;
	return { provider, modelId };
}

function failedStream(model: Model<any>, reason: string): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({
			type: "error",
			reason: "error",
			error: {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				errorMessage: reason,
				timestamp: Date.now(),
			},
		});
	});
	return stream;
}

export function createPiAdvisorAgentAdapter(
	ctx: Pick<ExtensionContext, "modelRegistry" | "signal">,
	input: PiAdvisorAgentAdapterInput,
): AdvisorAgentAdapter {
	const parsedModel = parseProviderModel(input.model);
	const systemPrompt = buildAdvisorSystemPrompt(input.sharedInstructions);
	const timeoutMs = Number.isFinite(input.timeoutMs) && Number(input.timeoutMs) > 0
		? Math.floor(Number(input.timeoutMs))
		: DEFAULT_TIMEOUT_MS;
	const createAgent = input.agentFactory ?? ((options: AgentOptions) => new Agent(options));
	const callStream = input.streamSimple ?? piStreamSimple;
	const estimateMessage = input.estimateTokens ?? estimateAgentMessageTokens;

	let agent: AdvisorAgentInstance | undefined;
	let agentAuth: AgentAuthState | undefined;
	let activeBuffer: AdvisorAttemptBuffer | undefined;
	const retiredAgents = new Set<Promise<void>>();
	let disposed = false;
	let reviewing = false;
	let tokenEstimate = 0;
	let lifecycle = 0;
	let stopActiveReview: (() => void) | undefined;

	function createStreamFn(authState: AgentAuthState) {
		return async (model: Model<any>, context: Context, options?: SimpleStreamOptions) => {
			const auth = authState.current;
			if (!auth) return failedStream(model, "advisor_auth_unavailable");
			try {
				return await callStream(model, context, {
					...options,
					apiKey: auth.apiKey,
					headers: { ...(options?.headers ?? {}), ...(auth.headers ?? {}) },
					env: { ...(options?.env ?? {}), ...(auth.env ?? {}) },
					timeoutMs,
					maxRetries: 0,
					maxRetryDelayMs: 0,
					metadata: { ...(options?.metadata ?? {}), purpose: "agent-experience-advisor" },
				});
			} catch {
				return failedStream(model, "advisor_unavailable");
			}
		};
	}

	function retireCurrentAgent(): void {
		const retiring = agent;
		const retiringAuth = agentAuth;
		if (!retiring) return;
		agent = undefined;
		agentAuth = undefined;
		if (retiringAuth) retiringAuth.current = undefined;
		retiring.abort();
		let cleanup: Promise<void>;
		cleanup = retiring.waitForIdle()
			.catch(() => undefined)
			.then(() => {
				retiring.reset();
				retiredAgents.delete(cleanup);
			});
		retiredAgents.add(cleanup);
	}

	function estimateContext(messages: AgentMessage[], pendingPrompt: string): number {
		const inputs: AgentMessage[] = [
			{ role: "user", content: systemPrompt, timestamp: 0 },
			...messages,
			{ role: "user", content: pendingPrompt, timestamp: 0 },
		];
		let total = 0;
		for (const message of inputs) {
			const value = estimateMessage(message);
			if (!Number.isFinite(value) || value < 0) throw new Error("Invalid Advisor token estimate");
			total += value;
		}
		return total;
	}

	return {
		get contextTokenEstimate() {
			return tokenEstimate;
		},

		async review(update, signal) {
			if (disposed || signal?.aborted || ctx.signal?.aborted) return [];
			if (reviewing || retiredAgents.size >= MAX_RETIRED_AGENTS || !parsedModel) reviewFailure("advisor_unavailable");
			reviewing = true;
			const reviewLifecycle = lifecycle;
			const stopped = Symbol("advisor_review_stopped");
			let timer: NodeJS.Timeout | undefined;
			let settleStop: (() => void) | undefined;
			let aborted = false;
			let timedOut = false;
			let reviewAuthState: AgentAuthState | undefined;
			const abortSignals = [signal, ctx.signal].filter((candidate): candidate is AbortSignal => candidate !== undefined);
			const stopPromise = new Promise<typeof stopped>((resolve) => {
				settleStop = () => resolve(stopped);
			});
			const abortReview = () => {
				aborted = true;
				agent?.abort();
				settleStop?.();
			};
			stopActiveReview = abortReview;
			for (const parentSignal of abortSignals) parentSignal.addEventListener("abort", abortReview, { once: true });
			timer = setTimeout(() => {
				timedOut = true;
				agent?.abort();
				settleStop?.();
			}, timeoutMs);

			try {
				const prompt = formatAdvisorUpdate(update);
				const model = ctx.modelRegistry.find(parsedModel.provider, parsedModel.modelId);
				if (!model || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0) reviewFailure("advisor_unavailable");
				const authOutcome = await Promise.race([
					ctx.modelRegistry.getApiKeyAndHeaders(model),
					stopPromise,
				]);
				if (authOutcome === stopped || signal?.aborted || ctx.signal?.aborted || disposed || lifecycle !== reviewLifecycle) {
					if (timedOut) reviewFailure("advisor_timeout");
					return [];
				}
				if (!authOutcome.ok) reviewFailure("advisor_auth_unavailable");
				const requestAuth: RequestAuth = { apiKey: authOutcome.apiKey, headers: authOutcome.headers, env: authOutcome.env };
				activeBuffer = new AdvisorAttemptBuffer(update.habits.map((habit) => habit.alias));
				const tools = [
					...createAdvisorWorkspaceTools(input.cwd, createAdvisorWorkspaceBudget()),
					...createAdvisorEmissionTools(activeBuffer),
				];

				if (!agent) {
					reviewAuthState = { current: requestAuth };
					agentAuth = reviewAuthState;
					agent = createAgent({
						initialState: {
							systemPrompt,
							model,
							thinkingLevel: "off",
							tools,
							messages: [],
						},
						streamFn: createStreamFn(reviewAuthState),
						toolExecution: "sequential",
						maxRetryDelayMs: 0,
					});
				} else {
					reviewAuthState = agentAuth;
					if (!reviewAuthState) reviewFailure("advisor_unavailable");
					agent.reset();
					reviewAuthState.current = requestAuth;
					agent.state.systemPrompt = systemPrompt;
					agent.state.model = model;
					agent.state.tools = tools;
				}

				try {
					if (agent.state.messages.length !== 0) reviewFailure("advisor_unavailable");
					tokenEstimate = estimateContext([], prompt);
					if (tokenEstimate >= model.contextWindow) reviewFailure("advisor_context_overflow");
				} catch (error) {
					tokenEstimate = 0;
					if (error instanceof Error && REVIEW_FAILURE_REASONS.has(error.message as AdvisorDiagnosticReason)) throw error;
					reviewFailure("advisor_unavailable");
				}

				const promptOutcome = await Promise.race([
					agent.prompt(prompt).then(() => true, () => false),
					stopPromise,
				]);
				if (promptOutcome === stopped || timedOut || aborted || signal?.aborted || ctx.signal?.aborted || disposed || lifecycle !== reviewLifecycle) {
					retireCurrentAgent();
					if (timedOut) reviewFailure("advisor_timeout");
					return [];
				}
				if (!promptOutcome) reviewFailure("advisor_unavailable");
				if (agent.state.errorMessage) {
					if (/context|token|length|overflow/i.test(agent.state.errorMessage)) {
						agent.reset();
						reviewFailure("advisor_context_overflow");
					}
					reviewFailure("advisor_unavailable");
				}
				return activeBuffer.drain();
			} catch (error) {
				if (error instanceof Error && REVIEW_FAILURE_REASONS.has(error.message as AdvisorDiagnosticReason)) throw error;
				reviewFailure("advisor_unavailable");
			} finally {
				clearTimeout(timer);
				for (const parentSignal of abortSignals) parentSignal.removeEventListener("abort", abortReview);
				if (stopActiveReview === abortReview) stopActiveReview = undefined;
				activeBuffer?.clear();
				activeBuffer = undefined;
				if (reviewAuthState) reviewAuthState.current = undefined;
				if (agent && lifecycle === reviewLifecycle) agent.reset();
				tokenEstimate = 0;
				reviewing = false;
			}
		},

		reset() {
			lifecycle++;
			stopActiveReview?.();
			retireCurrentAgent();
			activeBuffer?.clear();
			activeBuffer = undefined;
			tokenEstimate = 0;
		},

		async dispose() {
			if (disposed) return;
			disposed = true;
			lifecycle++;
			stopActiveReview?.();
			const current = agent;
			const currentAuth = agentAuth;
			agent = undefined;
			agentAuth = undefined;
			if (currentAuth) currentAuth.current = undefined;
			current?.abort();
			activeBuffer?.clear();
			activeBuffer = undefined;
			if (current) {
				await current.waitForIdle();
				current.reset();
			}
			await Promise.all([...retiredAgents]);
			tokenEstimate = 0;
		},
	};
}
