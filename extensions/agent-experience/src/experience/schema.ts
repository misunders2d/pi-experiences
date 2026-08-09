import { checksumJson } from "../storage/checksum.ts";
import {
	EXPERIENCE_AUTHORITIES,
	EXPERIENCE_HOSTS,
	EXPERIENCE_KINDS,
	EXPERIENCE_PROVENANCE_SOURCES,
	EXPERIENCE_SCOPE_KINDS,
	EXPERIENCE_STATUSES,
	type ExperienceCandidateInput,
	type ExperienceRecordV1,
} from "./types.ts";

const KIND_SET = new Set<string>(EXPERIENCE_KINDS);
const SCOPE_SET = new Set<string>(EXPERIENCE_SCOPE_KINDS);
const AUTHORITY_SET = new Set<string>(EXPERIENCE_AUTHORITIES);
const STATUS_SET = new Set<string>(EXPERIENCE_STATUSES);
const PROVENANCE_SOURCE_SET = new Set<string>(EXPERIENCE_PROVENANCE_SOURCES);
const HOST_SET = new Set<string>(EXPERIENCE_HOSTS);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const RECORD_KEYS = new Set([
	"schemaVersion",
	"id",
	"userId",
	"kind",
	"scope",
	"authority",
	"status",
	"applicability",
	"content",
	"rationale",
	"exceptions",
	"confidenceBp",
	"validFrom",
	"expiresAt",
	"lastConfirmedAt",
	"supersedes",
	"conflictsWith",
	"provenance",
	"checksum",
]);

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function assertExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, label: string): void {
	for (const key of Object.keys(value)) {
		if (!keys.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
	}
}

function requiredText(value: unknown, label: string, max = 8_000): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > max || CONTROL_PATTERN.test(value)) {
		throw new Error(`${label} must be non-empty bounded text`);
	}
	return value;
}

function optionalText(value: unknown, label: string, max = 8_000): string | undefined {
	if (value === undefined) return undefined;
	return requiredText(value, label, max);
}

function safeId(value: unknown, label: string): string {
	if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
	return value;
}

function isoTimestamp(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp`);
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
		throw new Error(`${label} must be a canonical ISO timestamp`);
	}
	return value;
}

function stringList(value: unknown, label: string, maxItems = 32): string[] {
	if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} must be a bounded array`);
	const values = value.map((item, index) => requiredText(item, `${label}[${index}]`, 2_000));
	if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates`);
	return values;
}

function idList(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.length > 64) throw new Error(`${label} must be a bounded array`);
	const values = value.map((item, index) => safeId(item, `${label}[${index}]`));
	if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates`);
	return values;
}

export function experienceChecksumPayload(record: Omit<ExperienceRecordV1, "checksum"> | ExperienceRecordV1) {
	return {
		schemaVersion: record.schemaVersion,
		id: record.id,
		userId: record.userId,
		kind: record.kind,
		scope: record.scope,
		authority: record.authority,
		status: record.status,
		applicability: record.applicability,
		content: record.content,
		...(record.rationale === undefined ? {} : { rationale: record.rationale }),
		exceptions: record.exceptions,
		confidenceBp: record.confidenceBp,
		validFrom: record.validFrom,
		...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
		lastConfirmedAt: record.lastConfirmedAt,
		supersedes: record.supersedes,
		conflictsWith: record.conflictsWith,
		provenance: record.provenance,
	};
}

export function computeExperienceChecksum(record: Omit<ExperienceRecordV1, "checksum"> | ExperienceRecordV1): string {
	return checksumJson(experienceChecksumPayload(record));
}

export function experienceApprovalIdentity(record: Pick<ExperienceRecordV1, "kind" | "scope" | "authority" | "applicability" | "content">): string {
	return checksumJson({
		kind: record.kind,
		scope: record.scope,
		authority: record.authority,
		applicability: record.applicability,
		content: record.content,
	});
}

export function validateExperienceRecord(value: unknown): ExperienceRecordV1 {
	assertPlainObject(value, "experience");
	assertExactKeys(value, RECORD_KEYS, "experience");
	if (value.schemaVersion !== 1) throw new Error("experience.schemaVersion must equal 1");
	const id = safeId(value.id, "experience.id");
	const userId = safeId(value.userId, "experience.userId");
	if (typeof value.kind !== "string" || !KIND_SET.has(value.kind)) throw new Error("experience.kind is invalid");
	assertPlainObject(value.scope, "experience.scope");
	assertExactKeys(value.scope, new Set(["kind", "key"]), "experience.scope");
	if (typeof value.scope.kind !== "string" || !SCOPE_SET.has(value.scope.kind)) throw new Error("experience.scope.kind is invalid");
	const scopeKey = optionalText(value.scope.key, "experience.scope.key", 2_000);
	if (value.scope.kind === "user" && scopeKey !== undefined) throw new Error("user scope must not have a key");
	if (value.scope.kind !== "user" && scopeKey === undefined) throw new Error("non-user scope requires a key");
	if (typeof value.authority !== "string" || !AUTHORITY_SET.has(value.authority)) throw new Error("experience.authority is invalid");
	if (typeof value.status !== "string" || !STATUS_SET.has(value.status)) throw new Error("experience.status is invalid");
	const applicability = requiredText(value.applicability, "experience.applicability");
	const content = requiredText(value.content, "experience.content");
	const rationale = optionalText(value.rationale, "experience.rationale");
	const exceptions = stringList(value.exceptions, "experience.exceptions");
	if (!Number.isInteger(value.confidenceBp) || Number(value.confidenceBp) < 0 || Number(value.confidenceBp) > 10_000) {
		throw new Error("experience.confidenceBp is invalid");
	}
	const validFrom = isoTimestamp(value.validFrom, "experience.validFrom");
	const expiresAt = value.expiresAt === undefined ? undefined : isoTimestamp(value.expiresAt, "experience.expiresAt");
	const lastConfirmedAt = isoTimestamp(value.lastConfirmedAt, "experience.lastConfirmedAt");
	if (Date.parse(lastConfirmedAt) < Date.parse(validFrom)) throw new Error("experience.lastConfirmedAt precedes validFrom");
	if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(validFrom)) throw new Error("experience.expiresAt must follow validFrom");
	if (value.status === "expired" && expiresAt === undefined) throw new Error("expired experience requires expiresAt");
	const supersedes = idList(value.supersedes, "experience.supersedes");
	const conflictsWith = idList(value.conflictsWith, "experience.conflictsWith");
	if (supersedes.includes(id) || conflictsWith.includes(id)) throw new Error("experience cannot relate to itself");
	if (supersedes.some(target => conflictsWith.includes(target))) throw new Error("experience relation cannot both supersede and conflict");
	if (!Array.isArray(value.provenance) || value.provenance.length === 0 || value.provenance.length > 64) {
		throw new Error("experience.provenance must be a non-empty bounded array");
	}
	const provenance = value.provenance.map((entry, index) => {
		assertPlainObject(entry, `experience.provenance[${index}]`);
		assertExactKeys(entry, new Set(["source", "host", "evidenceId", "observedAt"]), `experience.provenance[${index}]`);
		if (typeof entry.source !== "string" || !PROVENANCE_SOURCE_SET.has(entry.source)) throw new Error("experience provenance source is invalid");
		if (typeof entry.host !== "string" || !HOST_SET.has(entry.host)) throw new Error("experience provenance host is invalid");
		const observedAt = entry.observedAt === undefined
			? undefined
			: isoTimestamp(entry.observedAt, `experience.provenance[${index}].observedAt`);
		return {
			source: entry.source,
			host: entry.host,
			evidenceId: safeId(entry.evidenceId, `experience.provenance[${index}].evidenceId`),
			...(observedAt === undefined ? {} : { observedAt }),
		};
	});
	const provenanceKeys = provenance.map(entry => `${entry.host}\0${entry.evidenceId}`);
	if (new Set(provenanceKeys).size !== provenanceKeys.length) throw new Error("experience provenance contains duplicates");
	if (typeof value.checksum !== "string" || !CHECKSUM_PATTERN.test(value.checksum)) throw new Error("experience.checksum is invalid");

	const record = {
		schemaVersion: 1,
		id,
		userId,
		kind: value.kind,
		scope: scopeKey === undefined ? { kind: value.scope.kind } : { kind: value.scope.kind, key: scopeKey },
		authority: value.authority,
		status: value.status,
		applicability,
		content,
		...(rationale === undefined ? {} : { rationale }),
		exceptions,
		confidenceBp: Number(value.confidenceBp),
		validFrom,
		...(expiresAt === undefined ? {} : { expiresAt }),
		lastConfirmedAt,
		supersedes,
		conflictsWith,
		provenance,
		checksum: value.checksum,
	} as ExperienceRecordV1;
	if (computeExperienceChecksum(record) !== record.checksum) throw new Error("experience.checksum mismatch");
	return record;
}

export function buildExperienceCandidate(input: ExperienceCandidateInput): ExperienceRecordV1 {
	const record = { schemaVersion: 1, ...input, status: "candidate" } as Omit<ExperienceRecordV1, "checksum">;
	return validateExperienceRecord({ ...record, checksum: computeExperienceChecksum(record) });
}

export function isExperienceEligible(record: ExperienceRecordV1, input: { userId: string; now: string }): boolean {
	try {
		const valid = validateExperienceRecord(record);
		const now = isoTimestamp(input.now, "eligibility.now");
		return valid.userId === input.userId
			&& valid.status === "active"
			&& Date.parse(valid.validFrom) <= Date.parse(now)
			&& (valid.expiresAt === undefined || Date.parse(valid.expiresAt) > Date.parse(now));
	} catch {
		return false;
	}
}
