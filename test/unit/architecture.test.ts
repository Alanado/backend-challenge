import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	applicationWithoutInfrastructure,
	checkRule,
	domainWithoutFrameworks,
	extractImports,
	loadSourceFiles,
	type SourceFile,
} from "../support/architecture";

const root = join(import.meta.dir, "..", "..");
const modules = readdirSync(join(root, "src", "modules"), {
	withFileTypes: true,
})
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name);

/*
 * Decisions (documented, TST-U-13):
 *  - `import type` and `export ... from` count as imports: a type-only import of
 *    `@nestjs/*` or `@mikro-orm/*` still couples the domain to the framework.
 *  - Dynamic `import("x")` and `require("x")` with a string literal count too.
 *  - A non-literal dynamic import cannot be resolved statically; none is allowed
 *    in these layers by convention and review.
 *  - Comments are ignored.
 */
describe("TST-U-13 import scanner", () => {
	test.each([
		['import { A } from "@nestjs/common";', ["@nestjs/common"]],
		["import { A } from '@nestjs/common';", ["@nestjs/common"]],
		['import A from "x";', ["x"]],
		['import * as ns from "x";', ["x"]],
		['import "side-effect";', ["side-effect"]],
		['import type { T } from "@mikro-orm/core";', ["@mikro-orm/core"]],
		['import { type T, v } from "@mikro-orm/core";', ["@mikro-orm/core"]],
		['export { a } from "./a";', ["./a"]],
		['export * from "./b";', ["./b"]],
		['export type { T } from "./c";', ["./c"]],
		['const m = await import("@nestjs/core");', ["@nestjs/core"]],
		["const m = await import('@nestjs/core');", ["@nestjs/core"]],
		['const m = require("@mikro-orm/core");', ["@mikro-orm/core"]],
		['import {\n\ta,\n\tb,\n} from "multi/line";', ["multi/line"]],
	])("TST-U-13 detects %j", (source, expected) => {
		expect(extractImports(source)).toEqual(expected);
	});

	test("TST-U-13 ignores imports inside comments and mentions inside strings", () => {
		const source = [
			'// import { A } from "@nestjs/common";',
			'/* import { B } from "@mikro-orm/core"; */',
			"/*",
			' * import C from "@nestjs/core";',
			" */",
			'const text = "import x from @nestjs/common";',
			'import { ok } from "./ok";',
		].join("\n");
		expect(extractImports(source)).toEqual(["./ok"]);
	});

	test("TST-U-13 returns nothing for a file without imports", () => {
		expect(extractImports("export const a = 1;")).toEqual([]);
	});
});

describe("TST-U-13 rules catch violations (fixtures)", () => {
	const domainFile = (source: string): SourceFile => ({
		path: "src/modules/wagering/domain/x.ts",
		source,
	});

	test.each([
		['import { Injectable } from "@nestjs/common";'],
		['import type { Injectable } from "@nestjs/common";'],
		['import { Entity } from "@mikro-orm/core";'],
		['import type { EntityManager } from "@mikro-orm/postgresql";'],
		['const m = await import("@nestjs/common");'],
		['export { Entity } from "@mikro-orm/core";'],
		['const m = require("@nestjs/common");'],
	])("TST-U-13 domain rule flags %j", (source) => {
		const result = checkRule([domainFile(source)], domainWithoutFrameworks);
		expect(result.scanned).toBe(1);
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0]?.file).toBe("src/modules/wagering/domain/x.ts");
	});

	test("TST-U-13 domain rule also covers src/shared and every module", () => {
		const files: SourceFile[] = [
			{ path: "src/shared/a.ts", source: 'import "@nestjs/common";' },
			{
				path: "src/modules/wallet/domain/a.ts",
				source: 'import "@mikro-orm/core";',
			},
			{
				path: "src/modules/messaging/domain/events/a.ts",
				source: 'import "@nestjs/core";',
			},
		];
		const result = checkRule(files, domainWithoutFrameworks);
		expect(result.scanned).toBe(3);
		expect(result.violations).toHaveLength(3);
	});

	test("TST-U-13 domain rule does not apply outside shared and domain, and allows lookalikes", () => {
		const files: SourceFile[] = [
			{
				path: "src/modules/wagering/infrastructure/a.ts",
				source: 'import "@nestjs/common";',
			},
			{
				path: "src/modules/wagering/application/a.ts",
				source: 'import "@mikro-orm/core";',
			},
			{
				path: "src/shared/ok.ts",
				source: 'import "@nestjs-like/pkg"; import "mikro-orm-like";',
			},
		];
		const result = checkRule(files, domainWithoutFrameworks);
		expect(result.scanned).toBe(1);
		expect(result.violations).toEqual([]);
	});

	test.each([
		['import { R } from "../infrastructure/repo";'],
		['import type { R } from "../infrastructure/repo";'],
		['import { R } from "../../wallet/infrastructure/repo";'],
		['const m = await import("../infrastructure/repo");'],
		['export { R } from "./infrastructure/repo";'],
	])("TST-U-13 application rule flags %j", (source) => {
		const result = checkRule(
			[{ path: "src/modules/wagering/application/use-case.ts", source }],
			applicationWithoutInfrastructure,
		);
		expect(result.scanned).toBe(1);
		expect(result.violations).toHaveLength(1);
	});

	test("TST-U-13 application rule allows domain, ports and external packages", () => {
		const result = checkRule(
			[
				{
					path: "src/modules/wagering/application/use-case.ts",
					source: [
						'import { A } from "../domain/a";',
						'import { P } from "./ports";',
						'import { B } from "../../wallet/domain/b";',
						'import { Z } from "zod";',
					].join("\n"),
				},
			],
			applicationWithoutInfrastructure,
		);
		expect(result.scanned).toBe(1);
		expect(result.violations).toEqual([]);
	});
});

describe("TST-U-13 architecture of the real tree", () => {
	const files = loadSourceFiles(root);

	test("TST-U-13 the scanner finds the source tree (guards against a wrong root or glob)", () => {
		const paths = files.map((f) => f.path);
		expect(paths).toContain("src/shared/money.ts");
		expect(paths).toContain("src/modules/wallet/domain/wallet.ts");
		expect(paths).toContain("src/modules/wagering/domain/wager-transaction.ts");
		expect(paths).toContain("src/modules/messaging/domain/outbox-message.ts");
	});

	test("TST-U-13 shared and domain import neither @mikro-orm/* nor @nestjs/*", () => {
		const result = checkRule(files, domainWithoutFrameworks);
		// Non-vacuous: shared + the three domains already have files.
		expect(result.scanned).toBeGreaterThan(0);
		expect(result.violations).toEqual([]);
	});

	test("TST-U-13 every module has an application folder for the rule to cover", () => {
		expect(modules.length).toBeGreaterThan(0);
		for (const name of ["wallet", "wagering", "messaging"]) {
			expect(
				existsSync(join(root, "src", "modules", name, "application")),
			).toBe(true);
		}
	});

	// W2 ships no application code yet, so the rule scans 0 files here. The rule
	// is not switched off: the fixtures above prove it flags violations, and it
	// starts covering real files as soon as the first one lands in application/.
	test("TST-U-13 application never imports infrastructure (0 files scanned until W4+)", () => {
		const result = checkRule(files, applicationWithoutInfrastructure);
		const expectedScanned = files.filter((f) =>
			/^src\/modules\/[^/]+\/application\//.test(f.path),
		).length;
		expect(result.scanned).toBe(expectedScanned);
		expect(result.violations).toEqual([]);
	});
});
