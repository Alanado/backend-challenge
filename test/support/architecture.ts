import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SourceFile {
	/** Path relative to the repository root, with forward slashes. */
	path: string;
	source: string;
}

export interface Rule {
	name: string;
	appliesTo(path: string): boolean;
	isForbidden(specifier: string): boolean;
}

export interface Violation {
	file: string;
	specifier: string;
	rule: string;
}

/** Replaces comments with spaces (newlines kept), leaving string literals alone. */
function stripComments(source: string): string {
	let out = "";
	let i = 0;
	let quote: string | undefined;
	while (i < source.length) {
		const char = source.charAt(i);
		const next = source.charAt(i + 1);
		if (quote !== undefined) {
			out += char;
			if (char === "\\") {
				out += next;
				i += 2;
				continue;
			}
			if (char === quote) {
				quote = undefined;
			}
			i += 1;
		} else if (char === "/" && next === "/") {
			while (i < source.length && source.charAt(i) !== "\n") {
				out += " ";
				i += 1;
			}
		} else if (char === "/" && next === "*") {
			const end = source.indexOf("*/", i + 2);
			const stop = end === -1 ? source.length : end + 2;
			out += source.slice(i, stop).replace(/[^\n]/g, " ");
			i = stop;
		} else {
			if (char === '"' || char === "'" || char === "`") {
				quote = char;
			}
			out += char;
			i += 1;
		}
	}
	return out;
}

const IMPORT_PATTERNS: Array<{ pattern: RegExp; group: number }> = [
	// import ... from "x" / import type ... from "x" / export ... from "x"
	{
		pattern: /^[ \t]*(?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"']+)["']/gm,
		group: 1,
	},
	// import "x"
	{ pattern: /^[ \t]*import\s*["']([^"']+)["']/gm, group: 1 },
	// import("x")
	{ pattern: /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, group: 1 },
	// require("x")
	{ pattern: /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, group: 1 },
];

/** Module specifiers imported by a TypeScript source, in order of appearance. */
export function extractImports(source: string): string[] {
	const code = stripComments(source);
	const found: Array<{ index: number; specifier: string }> = [];
	for (const { pattern, group } of IMPORT_PATTERNS) {
		for (const match of code.matchAll(pattern)) {
			const specifier = match[group];
			if (specifier !== undefined) {
				found.push({ index: match.index ?? 0, specifier });
			}
		}
	}
	return found.sort((a, b) => a.index - b.index).map((f) => f.specifier);
}

export function checkRule(
	files: SourceFile[],
	rule: Rule,
): { scanned: number; violations: Violation[] } {
	const scoped = files.filter((file) => rule.appliesTo(file.path));
	const violations: Violation[] = [];
	for (const file of scoped) {
		for (const specifier of extractImports(file.source)) {
			if (rule.isForbidden(specifier)) {
				violations.push({ file: file.path, specifier, rule: rule.name });
			}
		}
	}
	return { scanned: scoped.length, violations };
}

/** `src/shared` and every `src/modules/*\/domain` import no ORM and no Nest. */
export const domainWithoutFrameworks: Rule = {
	name: "domain-without-frameworks",
	appliesTo: (path) =>
		path.startsWith("src/shared/") ||
		/^src\/modules\/[^/]+\/domain\//.test(path),
	isForbidden: (specifier) =>
		/^@mikro-orm\//.test(specifier) || /^@nestjs\//.test(specifier),
};

/** `src/modules/*\/application` never reaches into an `infrastructure` folder. */
export const applicationWithoutInfrastructure: Rule = {
	name: "application-without-infrastructure",
	appliesTo: (path) => /^src\/modules\/[^/]+\/application\//.test(path),
	isForbidden: (specifier) =>
		specifier.startsWith(".") &&
		specifier.split("/").includes("infrastructure"),
};

/** Every `.ts` file under `src`, with paths relative to `root`. */
export function loadSourceFiles(root: string): SourceFile[] {
	return readdirSync(join(root, "src"), { recursive: true })
		.map((entry) => String(entry).split("\\").join("/"))
		.filter((entry) => entry.endsWith(".ts"))
		.sort()
		.map((entry) => ({
			path: `src/${entry}`,
			source: readFileSync(join(root, "src", entry), "utf8"),
		}));
}
