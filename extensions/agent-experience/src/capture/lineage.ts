import { canonicalJson, sha256Hex } from "../storage/checksum.ts";

export interface CapturedCausalContext {
	lineage_ref: string;
	turn_ref: string;
	parent_turn_ref: string | null;
	independence_known: boolean;
}

interface SessionEntryLike {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	message?: { role?: string };
}

interface SessionManagerLike {
	getBranch(): SessionEntryLike[];
	getHeader(): { timestamp: string; parentSession?: string } | null;
}

function opaqueRef(kind: string, value: unknown): string {
	return sha256Hex(canonicalJson({ schema: "agent_experience_causal_ref_v1", kind, value }));
}

function isUserEntry(entry: SessionEntryLike): boolean {
	return entry.type === "message" && entry.message?.role === "user";
}

/**
 * Resolve only from Pi's current immutable branch. The input event records the leaf
 * before Pi appends its user entry; exactly one later user entry must exist when the
 * pair is persisted. Raw session/file/entry identifiers never leave this function.
 */
export function resolveCapturedCausalContext(sessionManager: SessionManagerLike, branchAnchorId: string | null): CapturedCausalContext | undefined {
	const branch = sessionManager.getBranch();
	if (!Array.isArray(branch) || branch.length === 0) return undefined;
	const anchorIndex = branchAnchorId === null ? -1 : branch.findIndex((entry) => entry.id === branchAnchorId);
	if (branchAnchorId !== null && anchorIndex < 0) return undefined;
	const laterUsers = branch.slice(anchorIndex + 1).filter(isUserEntry);
	if (laterUsers.length !== 1) return undefined;
	const turn = laterUsers[0];
	const priorUsers = branch.slice(0, branch.indexOf(turn)).filter(isUserEntry);
	const parent = priorUsers.at(-1);
	const root = [...priorUsers, turn][0];
	if (!root) return undefined;

	const header = sessionManager.getHeader();
	if (!header || !Number.isFinite(Date.parse(header.timestamp)) || !Number.isFinite(Date.parse(root.timestamp))) return undefined;
	// Pi copies entry ids/timestamps when it forks a non-empty branch, so copied roots
	// retain the same lineage. A parented session whose first user entry was created
	// after the new header has no copied ancestry; it must conservatively undercount.
	const independenceKnown = !(header.parentSession && Date.parse(root.timestamp) >= Date.parse(header.timestamp));
	const lineageRef = opaqueRef("lineage", { root_id: root.id, root_timestamp: root.timestamp });
	return {
		lineage_ref: lineageRef,
		turn_ref: opaqueRef("turn", { lineage_ref: lineageRef, entry_id: turn.id, entry_timestamp: turn.timestamp }),
		parent_turn_ref: parent ? opaqueRef("turn", { lineage_ref: lineageRef, entry_id: parent.id, entry_timestamp: parent.timestamp }) : null,
		independence_known: independenceKnown,
	};
}
