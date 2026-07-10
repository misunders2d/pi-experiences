import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentExperiencePaths, readAgentExperienceConfig } from "./paths.ts";
import { normalizeUserId } from "./storage/private-root.ts";
import { initExperienceStorage, openExistingExperienceStorage } from "./storage/sqlite.ts";
import { redactText } from "./storage/redaction.ts";
import { semanticPolicyFromConfig, createEmbeddingAdapterFromConfig } from "./semantic/config.ts";
import { listHabitDuplicates } from "./semantic/storage.ts";
import {
	acceptCandidateHabit,
	acceptPendingReview,
	declareUserHabit,
	listPendingReviewItems,
	normalizeDeclaredHabitWording,
	planHabitDuplicateResolution,
	readConfiguredLawSnapshot,
	rejectCandidateHabit,
	rejectPendingReview,
	resolveHabitDuplicate,
	showPendingReviewItem,
	type HabitDuplicateResolutionAction,
} from "./review.ts";
import {
	AgentExperienceConversationState,
	CONVERSATION_REVIEW_MAX_ITEMS,
	ConversationStateError,
	type ConversationalReviewMapping,
	type SanitizedDeclarationResult,
} from "./conversation.ts";
import type { CaptureKey } from "./capture/origin.ts";

const state = new AgentExperienceConversationState();
const REVIEW_ACTIONS = ["approve", "reject", "keep_separate", "merge", "supersede", "archive_duplicate"] as const;
type ReviewAction = typeof REVIEW_ACTIONS[number];

function configuredUserId(): string {
	return normalizeUserId(process.env.AX_USER_ID || "owner");
}

function conversationKey(ctx: Pick<ExtensionContext, "sessionManager"> | { sessionManager?: ExtensionContext["sessionManager"] }): CaptureKey | undefined {
	const sessionId = ctx.sessionManager?.getSessionId?.();
	const sessionFile = ctx.sessionManager?.getSessionFile?.();
	if (!sessionId || !sessionFile) return undefined;
	return { sessionId, sessionFile, userId: configuredUserId() };
}

function result(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function safeText(value: unknown, max: number): string {
	return redactText(String(value ?? "")).replace(/\s+/g, " ").trim().slice(0, max);
}

function stateFailure(error: unknown, operation: "confirm" | "review"): ReturnType<typeof result> | undefined {
	if (!(error instanceof ConversationStateError)) return undefined;
	if (error.code === "next_turn_required") return result(operation === "confirm"
		? "Do not save yet. Show the exact When/Do draft and wait for the user to answer in a new turn."
		: "Do not apply a review choice yet. Show the numbered list and wait for the user to choose in a new turn.", { outcome: "confirmation_required" });
	if (error.code === "confirmation_required") return result("No change was made because explicit user confirmation is required.", { outcome: "confirmation_required" });
	if (error.code === "missing_draft" || error.code === "expired") return result("That habit draft is no longer current. Draft the exact When/Do wording again and ask the user to confirm it.", { outcome: "draft_refresh_required" });
	if (error.code === "missing_snapshot" || error.code === "invalid_item") return result("That numbered review list is no longer current. Show the review list again before applying a decision.", { outcome: "review_refresh_required" });
	return result("Another Agent Experience action is still running. Wait for it to finish before retrying.", { outcome: "busy" });
}

function unavailable(operation: "draft" | "save" | "list" | "review") {
	const messages = {
		draft: "I couldn't safely prepare that habit draft. Nothing was saved.",
		save: "I couldn't safely save that habit. Nothing was changed. Open /experience setup if this continues.",
		list: "I couldn't safely read the habit review list. Open /experience setup if this continues.",
		review: "I couldn't safely apply that review decision. Nothing was changed. Show the review list again.",
	};
	return result(messages[operation], { outcome: "unavailable" });
}

async function requireEnabled(): Promise<{ root: string; config: Awaited<ReturnType<typeof readAgentExperienceConfig>>["config"] } | undefined> {
	const paths = getAgentExperiencePaths();
	const { config } = await readAgentExperienceConfig(paths);
	if (!config.enabled) return undefined;
	return { root: paths.root, config };
}

async function semanticRuntime(config: Awaited<ReturnType<typeof readAgentExperienceConfig>>["config"]) {
	const policy = semanticPolicyFromConfig(config);
	if (!policy.enabled) return { policy, provider: undefined };
	try {
		return { policy, provider: await createEmbeddingAdapterFromConfig(config) };
	} catch {
		return { policy, provider: undefined };
	}
}

function declarationResult(value: any): SanitizedDeclarationResult {
	if (value?.activated === true) return { outcome: "active", message: "Habit saved and active. It can be considered before relevant replies when approved-habit reminders are enabled." };
	if (value?.pending_reason === "duplicate") return { outcome: "duplicate_review", message: "Habit wording was saved, but it may duplicate an approved habit. Nothing was merged or replaced. Ask whether the user wants to review the possible duplicate." };
	if (value?.pending_reason === "law") return { outcome: "law_blocked", message: "Habit wording was saved but remains inactive because current safety instructions block it. Nothing unsafe was activated." };
	if (value?.pending_reason === "conflict") return { outcome: "conflict_blocked", message: "Habit wording was saved but remains inactive because it conflicts with another habit. Ask whether the user wants to review the conflict." };
	return { outcome: "not_saved", message: "The habit was not saved because local duplicate checking was unavailable. Nothing was changed; retry later or use /experience setup." };
}

function reviewSource(item: any): any {
	return item?.type === "candidate" ? { ...(item.payload || {}), condition: item.condition, behavior: item.behavior } : item?.payload || {};
}

function candidateDisplay(item: any, number: number): string {
	const source = reviewSource(item);
	const lines = [`${number}. Suggested habit`];
	if (source.condition) lines.push(`   When: ${safeText(source.condition, 220)}`);
	if (source.behavior) lines.push(`   Do: ${safeText(source.behavior, 320)}`);
	if (source.evidence_summary) lines.push(`   Reason: ${safeText(source.evidence_summary, 240)}`);
	lines.push("   Choices: approve or reject");
	return lines.join("\n");
}

function duplicateStatus(status: unknown): string {
	if (status === "active") return "approved and active";
	if (status === "disabled") return "approved but disabled";
	if (status === "candidate") return "suggested or waiting";
	return "currently unavailable";
}

function duplicateDisplay(item: any, habits: any[], number: number): string {
	const byId = new Map(habits.map((habit) => [String(habit.id), habit]));
	const first = byId.get(String(item.canonical_habit_id));
	const second = byId.get(String(item.duplicate_habit_id));
	if (!first || !second) return `${number}. Possible duplicate changed; show the list again.`;
	const label = (habit: any) => String(habit.id) === String(first.id) ? "First" : "Second";
	const describe = (action: HabitDuplicateResolutionAction): string => {
		const plan = planHabitDuplicateResolution(item, habits, action);
		if (action === "keep_separate") return "keep_separate — keep both habits";
		if (action === "merge") return `merge — keep ${label(plan.survivor)} wording, combine evidence, and hide ${label(plan.other)}`;
		if (action === "supersede") return `supersede — use ${label(plan.survivor)} wording and hide ${label(plan.other)} after final safety checks`;
		return `archive_duplicate — keep ${label(plan.survivor)} and hide ${label(plan.other)} without combining evidence`;
	};
	return [
		`${number}. Possible duplicate`,
		`   First (${duplicateStatus(first.status)})`,
		`   When: ${safeText(first.condition, 220)}`,
		`   Do: ${safeText(first.behavior, 320)}`,
		`   Second (${duplicateStatus(second.status)})`,
		`   When: ${safeText(second.condition, 220)}`,
		`   Do: ${safeText(second.behavior, 320)}`,
		`   Choices: ${["keep_separate", "merge", "supersede", "archive_duplicate"].map((action) => describe(action as HabitDuplicateResolutionAction)).join("; ")}`,
	].join("\n");
}

async function loadReview(kind: "candidates" | "duplicates" | "all", limit: number) {
	const enabled = await requireEnabled();
	if (!enabled) return { disabled: true, displays: [] as string[], mappings: [] as ConversationalReviewMapping[] };
	let storage: Awaited<ReturnType<typeof openExistingExperienceStorage>> | undefined;
	try {
		storage = await openExistingExperienceStorage(enabled.root, { userId: configuredUserId() });
		const displays: string[] = [];
		const mappings: ConversationalReviewMapping[] = [];
		if (kind !== "duplicates") {
			const candidates = listPendingReviewItems(storage.db, { userId: storage.userId }).items;
			for (const item of candidates) {
				if (mappings.length >= limit) break;
				mappings.push({ kind: "candidate", type: item.type, id: item.id, checksum: item.checksum });
				displays.push(candidateDisplay(item, mappings.length));
			}
		}
		if (kind !== "candidates" && mappings.length < limit) {
			const duplicates = listHabitDuplicates(storage.db, { userId: storage.userId, decision: "pending" }).slice(0, limit - mappings.length);
			const ids = [...new Set(duplicates.flatMap((row: any) => [row.habit_a, row.habit_b]))];
			const habits = ids.length ? storage.db.prepare(`SELECT id, status, condition, behavior, checksum FROM habits WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")}) ORDER BY id`).all(storage.userId, ...ids) : [];
			const byId = new Map(habits.map((habit: any) => [String(habit.id), habit]));
			for (const item of duplicates) {
				const expectedHabitChecksums = Object.fromEntries([item.habit_a, item.habit_b].map((id: string) => [String(id), String(byId.get(String(id))?.checksum || "")]));
				mappings.push({ kind: "duplicate", id: item.id, checksum: item.checksum, expectedHabitChecksums });
				displays.push(duplicateDisplay(item, habits, mappings.length));
			}
		}
		return { disabled: false, displays, mappings };
	} finally {
		storage?.db.close();
	}
}

export function noteAgentExperienceConversationInput(ctx: Pick<ExtensionContext, "sessionManager">): void {
	const key = conversationKey(ctx);
	if (key) state.noteUserInput(key);
}

export function registerAgentExperienceConversationalTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "agent_experience_draft_habit",
		label: "Draft habit",
		description: "Store a short-lived exact When/Do habit draft after discussing a pattern. This does not save or activate a habit.",
		promptSnippet: "Draft exact When/Do habit wording for natural conversational confirmation",
		promptGuidelines: [
			"For a user-requested habit, discuss the pattern naturally, then call agent_experience_draft_habit with exact When/Do wording and ask whether to save exactly that wording.",
			"Call agent_experience_confirm_habit only after the user clearly confirms in a later message. If wording changes, draft again first.",
			"Use agent_experience_list_review and agent_experience_apply_review for natural numbered suggestion/duplicate review. Never expose or request internal IDs, checksums, scores, providers, source references, raw examples, private paths, or audit data.",
		],
		parameters: Type.Object({
			condition: Type.String({ minLength: 1, maxLength: 2_000, description: "Exact condition text shown after When:" }),
			behavior: Type.String({ minLength: 1, maxLength: 2_000, description: "Exact behavior text shown after Do:" }),
			polarity: Type.Optional(Type.Union([Type.Literal("preference"), Type.Literal("avoidance")], { description: "Whether to do or avoid the behavior" })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const key = conversationKey(ctx);
			if (!key) return result("Conversational habit drafting is unavailable in this session. Use /experience setup.", { outcome: "missing_session" });
			try {
				if (!(await requireEnabled())) return result("Agent Experience is off. Use /experience setup to turn it on before saving habits.", { outcome: "disabled" });
				const condition = normalizeDeclaredHabitWording(params.condition, "condition");
				const behavior = normalizeDeclaredHabitWording(params.behavior, "behavior");
				state.putDraft(key, { condition, behavior, polarity: params.polarity === "avoidance" ? -1 : 1 });
				return result(["Exact habit draft:", "", `When: ${condition}`, `Do: ${behavior}`, "", "Ask the user whether to save exactly this habit. Do not call the save tool until the user answers clearly in a new message."].join("\n"), { outcome: "drafted" });
			} catch {
				return unavailable("draft");
			}
		},
	});

	pi.registerTool({
		name: "agent_experience_confirm_habit",
		label: "Save confirmed habit",
		description: "Save the current exact habit draft only after explicit user confirmation in a later message.",
		promptSnippet: "Save an exact drafted habit after explicit user confirmation",
		parameters: Type.Object({ confirmed: Type.Boolean({ description: "Must be true only after explicit user confirmation" }) }),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const key = conversationKey(ctx);
			if (!key) return result("Conversational habit saving is unavailable in this session. Use /experience setup.", { outcome: "missing_session" });
			let draft: ReturnType<typeof state.beginConfirmation>["draft"] | undefined;
			try {
				const begun = state.beginConfirmation(key, params.confirmed);
				draft = begun.draft;
				if (begun.completed) return result(begun.completed.message, { outcome: begun.completed.outcome });
				const enabled = await requireEnabled();
				if (!enabled) throw new Error("disabled");
				const law = await readConfiguredLawSnapshot(enabled.root, enabled.config);
				const runtime = await semanticRuntime(enabled.config);
				try {
					const storage = await initExperienceStorage(enabled.root, { allowInit: true, userId: key.userId });
					try {
						const saved = await declareUserHabit(storage.db, { userId: storage.userId, declarationId: draft.declarationId, condition: draft.condition, behavior: draft.behavior, polarity: draft.polarity, law, now: new Date().toISOString(), semantic: { ...runtime, signal } });
						const sanitized = declarationResult(saved);
						if (sanitized.outcome === "not_saved") state.failConfirmation(key, draft.declarationId);
						else state.completeConfirmation(key, draft.declarationId, sanitized);
						return result(sanitized.message, { outcome: sanitized.outcome });
					} finally {
						storage.db.close();
					}
				} finally {
					await runtime.provider?.close?.().catch(() => undefined);
				}
			} catch (error) {
				if (draft) state.failConfirmation(key, draft.declarationId);
				return stateFailure(error, "confirm") || unavailable("save");
			}
		},
	});

	pi.registerTool({
		name: "agent_experience_list_review",
		label: "Show habit review",
		description: "Show a sanitized numbered list of suggested habits and possible duplicate pairs for natural discussion.",
		promptSnippet: "Show numbered sanitized habit suggestions and duplicate pairs",
		parameters: Type.Object({
			kind: Type.Optional(Type.Union([Type.Literal("candidates"), Type.Literal("duplicates"), Type.Literal("all")], { default: "all" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: CONVERSATION_REVIEW_MAX_ITEMS, default: 20 })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const key = conversationKey(ctx);
			if (!key) return result("Conversational habit review is unavailable in this session. Use /experience setup.", { outcome: "missing_session" });
			try {
				const loaded = await loadReview(params.kind || "all", Math.max(1, Math.min(CONVERSATION_REVIEW_MAX_ITEMS, params.limit || 20)));
				if (loaded.disabled) return result("Agent Experience is off. Use /experience setup to turn it on.", { outcome: "disabled" });
				state.putReviewSnapshot(key, loaded.mappings);
				if (!loaded.displays.length) return result("No habit suggestions or possible duplicates are waiting for review.", { outcome: "empty", count: 0 });
				return result(["Habit review:", "", ...loaded.displays, "", "Discuss any item naturally. Apply a choice only after the user explicitly names a number and decision in a new message."].join("\n\n"), { outcome: "listed", count: loaded.displays.length });
			} catch {
				return unavailable("list");
			}
		},
	});

	pi.registerTool({
		name: "agent_experience_apply_review",
		label: "Apply habit review decision",
		description: "Apply one explicit user decision to a numbered item from the current conversational review list.",
		promptSnippet: "Apply an explicitly confirmed numbered habit-review decision",
		parameters: Type.Object({
			item_number: Type.Integer({ minimum: 1, maximum: CONVERSATION_REVIEW_MAX_ITEMS }),
			action: Type.Union(REVIEW_ACTIONS.map((action) => Type.Literal(action))),
			confirmed: Type.Boolean({ description: "Must be true only after the user explicitly chose this item and action" }),
			reason: Type.Optional(Type.String({ maxLength: 300, description: "Optional short user-stated reason, mainly for keep_separate" })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const key = conversationKey(ctx);
			if (!key) return result("Conversational habit review is unavailable in this session. Use /experience setup.", { outcome: "missing_session" });
			let mapping: ConversationalReviewMapping | undefined;
			try {
				mapping = state.beginReviewAction(key, params.item_number, params.confirmed);
				const enabled = await requireEnabled();
				if (!enabled) throw new Error("disabled");
				const storage = await openExistingExperienceStorage(enabled.root, { userId: key.userId });
				let runtime: Awaited<ReturnType<typeof semanticRuntime>> | undefined;
				try {
					if (mapping.kind === "candidate") {
						if (params.action !== "approve" && params.action !== "reject") {
							state.failReviewAction(key);
							return result("That choice does not apply to a suggested habit. Choose approve or reject.", { outcome: "unsupported_action" });
						}
						const shown = showPendingReviewItem(storage.db, { userId: storage.userId, id: mapping.id });
						if (shown.item.checksum !== mapping.checksum || shown.item.type !== mapping.type) throw new Error("stale review");
						if (mapping.type === "candidate") {
							if (params.action === "approve") {
								const law = await readConfiguredLawSnapshot(enabled.root, enabled.config);
								runtime = await semanticRuntime(enabled.config);
								const accepted = await acceptCandidateHabit(storage.db, { userId: storage.userId, habitId: mapping.id, checksum: mapping.checksum, law, now: new Date().toISOString(), semantic: { ...runtime, signal } });
								state.completeReviewAction(key);
								if (accepted?.semantic?.reason === "semantic_duplicate") return result("Suggestion approved, but it remains inactive until its possible duplicate is resolved. Nothing was merged automatically.", { outcome: "duplicate_review" });
								if (accepted?.activated) return result("Suggestion approved and active.", { outcome: "approved_active" });
								return result("Suggestion approved but still inactive while its remaining checks are unresolved.", { outcome: "approved_pending" });
							}
							rejectCandidateHabit(storage.db, { userId: storage.userId, habitId: mapping.id, checksum: mapping.checksum, now: new Date().toISOString() });
						} else if (params.action === "approve") {
							acceptPendingReview(storage.db, { userId: storage.userId, id: mapping.id, checksum: mapping.checksum, now: new Date().toISOString() });
						} else {
							rejectPendingReview(storage.db, { userId: storage.userId, id: mapping.id, checksum: mapping.checksum, now: new Date().toISOString() });
						}
						state.completeReviewAction(key);
						return result(params.action === "approve" ? "Suggestion approved." : "Suggestion rejected.", { outcome: params.action === "approve" ? "approved" : "rejected" });
					}
					if (params.action === "approve" || params.action === "reject") {
						state.failReviewAction(key);
						return result("That choice does not resolve a possible duplicate. Choose keep_separate, merge, supersede, or archive_duplicate.", { outcome: "unsupported_action" });
					}
					const relation = listHabitDuplicates(storage.db, { userId: storage.userId, decision: "pending" }).find((row: any) => row.id === mapping.id);
					if (!relation || relation.checksum !== mapping.checksum) throw new Error("stale review");
					const expected = mapping.expectedHabitChecksums;
					const ids = [relation.habit_a, relation.habit_b];
					const habits = storage.db.prepare("SELECT id, checksum FROM habits WHERE user_id = ? AND id IN (?, ?)").all(storage.userId, ...ids);
					if (habits.length !== 2 || habits.some((habit: any) => expected[String(habit.id)] !== String(habit.checksum))) throw new Error("stale review");
					const action = params.action as HabitDuplicateResolutionAction;
					const law = action === "supersede" ? await readConfiguredLawSnapshot(enabled.root, enabled.config) : undefined;
					resolveHabitDuplicate(storage.db, { userId: storage.userId, duplicateId: relation.id, checksum: relation.checksum, action, reason: safeText(params.reason || "user confirmed conversational review", 300), expectedHabitChecksums: expected, ...(law ? { law } : {}), now: new Date().toISOString() });
					state.completeReviewAction(key);
					const messages: Record<HabitDuplicateResolutionAction, string> = {
						keep_separate: "Kept both habits separate.",
						merge: "Merged the duplicate pair using the reviewed canonical wording and combined evidence; the other habit was archived.",
						supersede: "Superseded the prior habit with the reviewed replacement after final safety checks.",
						archive_duplicate: "Kept the canonical habit and archived the duplicate without combining evidence.",
					};
					return result(messages[action], { outcome: action });
				} finally {
					await runtime?.provider?.close?.().catch(() => undefined);
					storage.db.close();
				}
			} catch (error) {
				const stale = /stale|changed|refresh|not found|disappeared/i.test(String((error as any)?.message || ""));
				if (mapping) state.failReviewAction(key, stale);
				return stateFailure(error, "review") || (stale ? result("That review item changed. Nothing was applied; show the numbered review list again.", { outcome: "review_refresh_required" }) : unavailable("review"));
			}
		},
	});
}
