import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildAdvisorCustomMessage } from "../../extensions/agent-experience/src/advisor/message.ts";
import type { AcceptedAdvisorFinding, AdvisorHabitCandidate, AdvisorUpdate } from "../../extensions/agent-experience/src/advisor/types.ts";

const fingerprint = "f".repeat(64);
const habit: AdvisorHabitCandidate = {
	alias: "h-private-smoke-alias",
	habitId: "private-smoke-habit-id",
	condition: "When publishing an installed package from a clean branch",
	behavior: "Verify the freshly packed artifact in an isolated Pi session before release",
	checksum: "c".repeat(64),
	lawHash: "d".repeat(64),
};
const update: AdvisorUpdate = {
	schemaVersion: 1,
	scope: { userId: "private-smoke-user", sessionId: "private-smoke-session", sessionFile: "/private/smoke/session.jsonl" },
	generation: 1,
	epoch: 1,
	cursor: 1,
	inProgress: false,
	primaryDelta: "private raw primary transcript excerpt",
	currentRequest: "private raw user request",
	habits: [habit],
	eventFingerprint: fingerprint,
	causalEpisodeId: "private-smoke-episode",
	causedByAdvisor: false,
};

const fixtures: Record<string, AcceptedAdvisorFinding> = {
	"generic-nit": {
		kind: "generic_advice",
		severity: "nit",
		eventFingerprint: fingerprint,
		note: "Tighten the final summary so each claimed result names the exact command evidence that supports it without repeating implementation detail.",
	},
	"generic-concern": {
		kind: "generic_advice",
		severity: "concern",
		eventFingerprint: fingerprint,
		note: "Check that the isolated verification really uses the freshly packed dependency tree rather than repository files, shared npm cache contents, or a global Pi installation.",
	},
	"generic-blocker": {
		kind: "generic_advice",
		severity: "blocker",
		eventFingerprint: fingerprint,
		note: "Stop before release because the claimed package proof must include both grouped setup and Advisor terminal behavior at wide and narrow terminal widths.",
	},
	habit: {
		kind: "habit_violation",
		severity: "blocker",
		eventFingerprint: fingerprint,
		candidate: habit,
	},
};

export default function advisorTuiDriver(pi: ExtensionAPI): void {
	let sequence = 0;
	pi.registerCommand("advisor-smoke", {
		description: "Emit one deterministic Advisor renderer fixture through Pi's public custom-message API",
		handler: async (args) => {
			const fixture = fixtures[String(args || "").trim().toLowerCase()];
			if (!fixture) throw new Error("usage: /advisor-smoke generic-nit|generic-concern|generic-blocker|habit");
			sequence += 1;
			pi.sendMessage(buildAdvisorCustomMessage(fixture, { ...update, generation: sequence, cursor: sequence }), { triggerTurn: false });
		},
	});
}
