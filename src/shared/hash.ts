import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted lexicographically (recursively),
 * no whitespace, strings escaped by `JSON.stringify`. `undefined` properties
 * are omitted like `JSON.stringify` does; values JSON cannot represent throw.
 * Objects exposing `toJSON` (e.g. `Money`) are serialized through it.
 */
export function canonicalJson(value: unknown): string {
	if (value === null) {
		return "null";
	}
	switch (typeof value) {
		case "string":
		case "boolean":
			return JSON.stringify(value);
		case "number":
			if (!Number.isFinite(value)) {
				throw new TypeError(
					"canonicalJson cannot serialize a non-finite number",
				);
			}
			return JSON.stringify(value);
		case "object":
			return canonicalObject(value);
		default:
			throw new TypeError(`canonicalJson cannot serialize a ${typeof value}`);
	}
}

function canonicalObject(value: object): string {
	if ("toJSON" in value && typeof value.toJSON === "function") {
		return canonicalJson(value.toJSON());
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}
	const entries = Object.entries(value)
		.filter(([, item]) => item !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries
		.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
		.join(",")}}`;
}

/** SHA-256 of the UTF-8 bytes, lowercase hexadecimal. */
export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}
