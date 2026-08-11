const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(?:token|api[_-]?key|secret|password|authorization|private[_-]?key|credential|path|file)/i;
const SENSITIVE_ASSIGNMENT_KEY_SOURCE = String.raw`(?:api[_-]?key|secret|password|token|credential|authorization|private[_-]?key)`;
const SENSITIVE_ASSIGNMENT_SOURCE = String.raw`["'\x60]?\b${SENSITIVE_ASSIGNMENT_KEY_SOURCE}\b["'\x60]?\s*[:=]\s*(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|\x60(?:\\.|[^\x60\\\r\n])*\x60|[^\s,;}\]]+)`;
const REDACTED_ASSIGNMENT_SOURCE = String.raw`["'\x60]?\b${SENSITIVE_ASSIGNMENT_KEY_SOURCE}\b["'\x60]?\s*[:=]\s*["'\x60]?\[REDACTED\]["'\x60]?`;
const CREDENTIAL_URL_SOURCE = String.raw`\b[a-z][a-z0-9+.-]*:\/\/[^\s\/@:]+:[^\s\/@]+@[^\s]+`;
const SECRET_TOKEN_SOURCE = [
	String.raw`\bsk-[A-Za-z0-9_-]{12,}(?![A-Za-z0-9_-])`,
	String.raw`\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b`,
	String.raw`\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b`,
	String.raw`\bxox[baprs]-[A-Za-z0-9-]{8,}(?![A-Za-z0-9-])`,
	String.raw`\bya29\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])`,
	String.raw`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`,
].join("|");

function sensitiveAssignmentRegex(flags = "i"): RegExp {
	return new RegExp(SENSITIVE_ASSIGNMENT_SOURCE, flags);
}

function credentialUrlRegex(flags = "i"): RegExp {
	return new RegExp(CREDENTIAL_URL_SOURCE, flags);
}

function secretTokenRegex(flags = ""): RegExp {
	return new RegExp(SECRET_TOKEN_SOURCE, flags);
}

export function redactText(input: string): string {
	return String(input)
		.replace(/-----BEGIN [A-Z ]*(?:PRIVATE KEY|SECRET KEY)[\s\S]*?-----END [A-Z ]*(?:PRIVATE KEY|SECRET KEY)-----/g, REDACTED)
		.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, REDACTED)
		.replace(/(?:\+?1[-.\s])?(?:\(?\d{3}\)?[-.\s])\d{3}[-.\s]\d{4}\b/g, REDACTED)
		.replace(secretTokenRegex("g"), REDACTED)
		.replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, REDACTED)
		.replace(/(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, REDACTED)
		.replace(credentialUrlRegex("gi"), REDACTED)
		.replace(sensitiveAssignmentRegex("gi"), REDACTED)
		.replace(/(?:~\/|\/(?:home|Users|var\/folders|tmp|media|mnt|Volumes)\/[^\s"']+|[A-Za-z]:\\Users\\[^\s"']+)/g, REDACTED);
}

export function redactJson<T>(input: T): T {
	function visit(value: any, key = ""): any {
		if (key !== "file_generation" && SENSITIVE_KEY.test(key)) return REDACTED;
		if (typeof value === "string") return redactText(value);
		if (Array.isArray(value)) return value.map((item) => visit(item));
		if (value && typeof value === "object") {
			const out: Record<string, unknown> = {};
			for (const [childKey, childValue] of Object.entries(value)) out[childKey] = visit(childValue, childKey);
			return out;
		}
		return value;
	}
	return visit(input) as T;
}

export function containsUnredactedSensitiveText(value: unknown): boolean {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	const normalized = text || "";
	const assignmentScan = normalized.replace(new RegExp(REDACTED_ASSIGNMENT_SOURCE, "gi"), REDACTED);
	return /-----BEGIN [A-Z ]*(?:PRIVATE KEY|SECRET KEY)|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?1[-.\s])?(?:\(?\d{3}\)?[-.\s])\d{3}[-.\s]\d{4}|\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b|(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}|(?:~\/|\/(?:home|Users|var\/folders|tmp|media|mnt|Volumes)\/[^\s"']+|[A-Za-z]:\\Users\\[^\s"']+)/i.test(normalized)
		|| secretTokenRegex().test(normalized)
		|| credentialUrlRegex().test(normalized)
		|| sensitiveAssignmentRegex().test(assignmentScan);
}
