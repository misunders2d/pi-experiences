import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
	function normalize(input: any): any {
		if (input === undefined) return null;
		if (input === null || typeof input !== "object") return input;
		if (Array.isArray(input)) return input.map(normalize);
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(input).sort()) out[key] = normalize(input[key]);
		return out;
	}
	return JSON.stringify(normalize(value));
}

export function sha256Hex(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

export function checksumJson(value: unknown): string {
	return sha256Hex(canonicalJson(value));
}
