import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");

const expectedDirs = [
	"src/shared",
	...["wallet", "wagering", "messaging"].flatMap((m) =>
		["domain", "application", "infrastructure"].map(
			(l) => `src/modules/${m}/${l}`,
		),
	),
	"src/modules/platform",
	"test/unit",
	"test/integration",
	"test/concurrency",
	"test/support",
];

describe("RNF-01 scaffold", () => {
	test("RNF-01 scaffold enables strict TypeScript flags", () => {
		const tsconfig = JSON.parse(
			readFileSync(join(root, "tsconfig.json"), "utf8"),
		) as { compilerOptions: Record<string, unknown> };
		expect(tsconfig.compilerOptions.strict).toBe(true);
		expect(tsconfig.compilerOptions.noUncheckedIndexedAccess).toBe(true);
	});

	test("RNF-01 scaffold has the expected folder structure", () => {
		const missing = expectedDirs.filter((d) => !existsSync(join(root, d)));
		expect(missing).toEqual([]);
	});
});
