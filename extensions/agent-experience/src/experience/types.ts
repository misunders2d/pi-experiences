export const EXPERIENCE_KINDS = [
	"habit",
	"preference",
	"constraint",
	"fact",
	"decision",
	"episode",
	"goal",
] as const;
export type ExperienceKind = (typeof EXPERIENCE_KINDS)[number];

export const EXPERIENCE_SCOPE_KINDS = ["user", "runtime", "workspace", "repository", "project"] as const;
export type ExperienceScopeKind = (typeof EXPERIENCE_SCOPE_KINDS)[number];

export const EXPERIENCE_AUTHORITIES = ["explicit_user", "reviewed_inference", "observed_outcome"] as const;
export type ExperienceAuthority = (typeof EXPERIENCE_AUTHORITIES)[number];

export const EXPERIENCE_STATUSES = ["candidate", "active", "superseded", "expired", "disabled"] as const;
export type ExperienceStatus = (typeof EXPERIENCE_STATUSES)[number];

export const EXPERIENCE_PROVENANCE_SOURCES = [
	"explicit_user",
	"conversation",
	"advisor_finding",
	"migration",
] as const;
export type ExperienceProvenanceSource = (typeof EXPERIENCE_PROVENANCE_SOURCES)[number];

export const EXPERIENCE_HOSTS = ["pi", "omp", "standalone", "migration"] as const;
export type ExperienceHost = (typeof EXPERIENCE_HOSTS)[number];

export interface ExperienceScope {
	kind: ExperienceScopeKind;
	key?: string;
}

export interface ExperienceProvenance {
	source: ExperienceProvenanceSource;
	host: ExperienceHost;
	evidenceId: string;
	observedAt: string;
}

export interface ExperienceRecordV1 {
	schemaVersion: 1;
	id: string;
	userId: string;
	kind: ExperienceKind;
	scope: ExperienceScope;
	authority: ExperienceAuthority;
	status: ExperienceStatus;
	applicability: string;
	content: string;
	rationale?: string;
	exceptions: string[];
	confidenceBp: number;
	validFrom: string;
	expiresAt?: string;
	lastConfirmedAt: string;
	supersedes: string[];
	conflictsWith: string[];
	provenance: ExperienceProvenance[];
	checksum: string;
}

export type ExperienceCandidateInput = Omit<ExperienceRecordV1, "schemaVersion" | "status" | "checksum">;
