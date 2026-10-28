import { describe, expect, test } from "bun:test";
import {
	CANDIDATE_END_MARKER,
	candidateSection,
	extractBunRunTargets,
	findInvalidTargets,
	findMissingRequired,
	REQUIRED_COMMANDS,
} from "../../../scripts/lib/readme-commands";

const SCRIPTS = {
	test: "bun run test:unit",
	"test:unit": "bun test test/unit",
	"queues:create": "bun run scripts/create-queues.ts",
};

describe("T-060 check-readme-commands", () => {
	test("extracts every `bun run <script>` from fenced blocks and inline code, once each", () => {
		const markdown = [
			"```bash",
			"bun run test:unit",
			"bun run test:unit  # de novo",
			"SQS_ENDPOINT=http://localhost:4567 bun run queues:create",
			"```",
			"Use `bun run test` para tudo.",
			"Texto solto: bun run não é comando aqui? bun runner também não.",
		].join("\n");
		expect(extractBunRunTargets(markdown)).toEqual([
			"test:unit",
			"queues:create",
			"test",
		]);
	});

	test("keeps file targets (`bun run scripts/x.ts`) apart from script names", () => {
		expect(extractBunRunTargets("`bun run scripts/check-readme.ts`")).toEqual([
			"scripts/check-readme.ts",
		]);
	});

	test("reports scripts that package.json does not define", () => {
		const bad = findInvalidTargets(
			["test", "test:load", "queues:create"],
			SCRIPTS,
			() => true,
		);
		expect(bad).toEqual(["test:load"]);
	});

	test("reports file targets that do not exist", () => {
		const bad = findInvalidTargets(
			["scripts/a.ts", "scripts/b.ts"],
			SCRIPTS,
			(path) => path === "scripts/a.ts",
		);
		expect(bad).toEqual(["scripts/b.ts"]);
	});

	test("reports required commands that the README does not mention", () => {
		const required = ["test:unit", "test:integration"];
		expect(findMissingRequired(["test:unit", "dev"], required)).toEqual([
			"test:integration",
		]);
	});

	test("the required list covers setup, every test level and the three-instance smoke", () => {
		expect(REQUIRED_COMMANDS).toEqual(
			expect.arrayContaining([
				"test:infra:up",
				"test:infra:down",
				"migration:up",
				"dev",
				"test:unit",
				"test:integration",
				"test:concurrency",
				"test",
				"compose:smoke",
			]),
		);
	});

	test("candidate section is what comes before the end marker; the original statement is out", () => {
		const readme = `# Candidato\nbun run dev\n${CANDIDATE_END_MARKER}\n# Enunciado\nbun run test:load\n`;
		const section = candidateSection(readme);
		expect(section).toContain("bun run dev");
		expect(section).not.toContain("test:load");
	});

	test("a README without the end marker is an error, never silently the whole file", () => {
		expect(() => candidateSection("# sem marcador\n")).toThrow(/marker/i);
	});
});
