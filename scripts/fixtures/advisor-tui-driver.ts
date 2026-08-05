import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildAdvisorCustomMessage } from "../../extensions/agent-experience/src/advisor/message.ts";
import type { AcceptedAdvisorFinding, AdvisorHabitCandidate, AdvisorUpdate } from "../../extensions/agent-experience/src/advisor/types.ts";

const fingerprint = "f".repeat(64);
const habit: AdvisorHabitCandidate = {
	alias: "h1",
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
	configuredLaw: "Direct current user instructions override approved habits.",
	habits: [habit],
	eventFingerprint: fingerprint,
	causalEpisodeId: "private-smoke-episode",
	causedByAdvisor: false,
};

const fixtures: Record<string, AcceptedAdvisorFinding> = {
	"habit-concern": {
		kind: "habit_violation",
		severity: "concern",
		eventFingerprint: fingerprint,
		candidate: habit,
	},
	"habit-blocker": {
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
			if (!fixture) throw new Error("usage: /advisor-smoke habit-concern|habit-blocker");
			sequence += 1;
			pi.sendMessage(buildAdvisorCustomMessage(fixture, { ...update, generation: sequence, cursor: sequence }), { triggerTurn: false });
		},
	});
}
