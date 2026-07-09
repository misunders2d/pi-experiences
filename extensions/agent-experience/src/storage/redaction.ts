const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(?:token|api[_-]?key|secret|password|authorization|private[_-]?key|credential|path|file)/i;

export function redactText(input: string): string {
	return String(input)
		.replace(/-----BEGIN [A-Z ]*(?:PRIVATE KEY|SECRET KEY)[\s\S]*?-----END [A-Z ]*(?:PRIVATE KEY|SECRET KEY)-----/g, REDACTED)
		.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, REDACTED)
		.replace(/(?:\+?1[-.\s])?(?:\(?\d{3}\)?[-.\s])\d{3}[-.\s]\d{4}\b/g, REDACTED)
		.replace(/\b(?:sk|pk|ghp|xox[baprs]|ya29|AKIA)[A-Za-z0-9_\-]{8,}\b/g, REDACTED)
		.replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, REDACTED)
		.replace(/(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, REDACTED)
		.replace(/\b(?:api[_-]?key|secret|password|token|credential)\s*[:=]\s*["'`]?[^\s"'`]{8,}["'`]?/gi, REDACTED)
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
	return /-----BEGIN [A-Z ]*(?:PRIVATE KEY|SECRET KEY)|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?1[-.\s])?(?:\(?\d{3}\)?[-.\s])\d{3}[-.\s]\d{4}|(?:sk|pk|ghp|xox[baprs]|ya29|AKIA)[A-Za-z0-9_\-]{8,}|\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b|(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:api[_-]?key|secret|password|token|credential)\s*[:=]\s*["'`]?[^\s"'`]{8,}["'`]?|(?:~\/|\/(?:home|Users|var\/folders|tmp|media|mnt|Volumes)\/[^\s"']+|[A-Za-z]:\\Users\\[^\s"']+)/i.test(text || "");
}
