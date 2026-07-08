import { normalizeUserId } from "../storage/private-root.ts";
import { canonicalJson, checksumJson } from "../storage/checksum.ts";

export interface ProposalSourceRef {
	file_generation: string;
	seq: number;
	checksum: string;
}

export interface HabitCandidateProposal {
	proposal_id: string;
	kind: "habit_candidate";
	candidate_key: string;
	condition: string;
	behavior: string;
	polarity: 1 | -1;
	confidence_bp: number;
	source_refs: ProposalSourceRef[];
	evidence_summary?: string;
	ambiguous?: false;
}

export interface ProposalBatch {
	schema_version: 1;
	user_id: string;
	batch_id: string;
	created_at: string;
	proposals: HabitCandidateProposal[];
}

export interface ValidatedProposalBatch extends ProposalBatch {
	user_id: string;
	checksum: string;
}

const TOP_LEVEL_KEYS = new Set(["schema_version", "user_id", "batch_id", "created_at", "proposals"]);
const PROPOSAL_KEYS = new Set([
	"proposal_id",
	"kind",
	"candidate_key",
	"condition",
	"behavior",
	"polarity",
	"confidence_bp",
	"source_refs",
	"evidence_summary",
	"ambiguous",
]);
const REF_KEYS = new Set(["file_generation", "seq", "checksum"]);

function assertExactKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`${label} has unsupported field: ${key}`);
	}
}

function assertSafeToken(value: unknown, label: string, max = 160): string {
	if (typeof value !== "string" || value.length < 1 || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
		throw new Error(`Invalid ${label}`);
	}
	return value;
}

function assertSafeGeneration(value: unknown): string {
	const generation = assertSafeToken(value, "file_generation", 80);
	if (!/^[A-Za-z0-9._-]+$/.test(generation)) throw new Error("Invalid file_generation");
	return generation;
}

function validateSourceRef(value: unknown): ProposalSourceRef {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid proposal source ref");
	const ref = value as Record<string, unknown>;
	assertExactKeys(ref, REF_KEYS, "proposal source ref");
	const seq = ref.seq;
	if (!Number.isInteger(seq) || Number(seq) < 1) throw new Error("Invalid proposal source seq");
	const checksum = assertSafeToken(ref.checksum, "source checksum", 128);
	if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error("Invalid proposal source checksum");
	return { file_generation: assertSafeGeneration(ref.file_generation), seq: Number(seq), checksum };
}

function validateProposal(value: unknown, seenIds: Set<string>): HabitCandidateProposal {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid proposal");
	const proposal = value as Record<string, unknown>;
	assertExactKeys(proposal, PROPOSAL_KEYS, "proposal");
	if (proposal.ambiguous === true) throw new Error("Ambiguous proposal");
	if (proposal.ambiguous !== undefined && proposal.ambiguous !== false) throw new Error("Invalid ambiguous flag");
	if (proposal.kind !== "habit_candidate") throw new Error("Unsupported proposal kind");
	const proposalId = assertSafeToken(proposal.proposal_id, "proposal_id");
	if (seenIds.has(proposalId)) throw new Error("Duplicate proposal_id");
	seenIds.add(proposalId);
	const candidateKey = assertSafeToken(proposal.candidate_key, "candidate_key");
	const condition = assertSafeToken(proposal.condition, "condition", 1000);
	const behavior = assertSafeToken(proposal.behavior, "behavior", 1000);
	const polarity = proposal.polarity;
	if (polarity !== 1 && polarity !== -1) throw new Error("Invalid proposal polarity");
	const confidenceBp = proposal.confidence_bp;
	if (!Number.isInteger(confidenceBp) || Number(confidenceBp) < 0 || Number(confidenceBp) > 10000) throw new Error("Invalid confidence_bp");
	if (!Array.isArray(proposal.source_refs) || proposal.source_refs.length < 1 || proposal.source_refs.length > 20) throw new Error("Invalid proposal source_refs");
	const sourceRefs = proposal.source_refs.map(validateSourceRef);
	const generations = new Set(sourceRefs.map((ref) => ref.file_generation));
	if (generations.size !== 1) throw new Error("Ambiguous proposal generation");
	const evidenceSummary = proposal.evidence_summary === undefined ? undefined : assertSafeToken(proposal.evidence_summary, "evidence_summary", 1000);
	return {
		proposal_id: proposalId,
		kind: "habit_candidate",
		candidate_key: candidateKey,
		condition,
		behavior,
		polarity,
		confidence_bp: Number(confidenceBp),
		source_refs: sourceRefs,
		...(evidenceSummary === undefined ? {} : { evidence_summary: evidenceSummary }),
		...(proposal.ambiguous === undefined ? {} : { ambiguous: false }),
	};
}

export function validateProposalBatch(value: unknown, expectedUserId?: string): ValidatedProposalBatch {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid proposal batch");
	const batch = value as Record<string, unknown>;
	assertExactKeys(batch, TOP_LEVEL_KEYS, "proposal batch");
	if (batch.schema_version !== 1) throw new Error("Unsupported proposal schema_version");
	const userId = normalizeUserId(assertSafeToken(batch.user_id, "user_id", 120));
	if (expectedUserId !== undefined && userId !== normalizeUserId(expectedUserId)) throw new Error("Proposal batch user_id mismatch");
	const batchId = assertSafeToken(batch.batch_id, "batch_id");
	const createdAt = assertSafeToken(batch.created_at, "created_at", 80);
	if (Number.isNaN(Date.parse(createdAt))) throw new Error("Invalid proposal created_at");
	if (!Array.isArray(batch.proposals) || batch.proposals.length < 1 || batch.proposals.length > 200) throw new Error("Invalid proposal list");
	const seenIds = new Set<string>();
	const proposals = batch.proposals.map((proposal) => validateProposal(proposal, seenIds));
	const normalized: ProposalBatch = { schema_version: 1, user_id: userId, batch_id: batchId, created_at: createdAt, proposals };
	return { ...normalized, checksum: checksumJson({ schema: "agent_experience_proposal_batch_v1", batch: JSON.parse(canonicalJson(normalized)) }) };
}
