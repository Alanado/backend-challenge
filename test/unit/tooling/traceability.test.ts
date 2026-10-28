import { describe, expect, test } from "bun:test";
import {
	expandRequirementRefs,
	extractTstIds,
	NON_TEST_VERIFICATION,
	parseRequirements,
	parseTasks,
	parseTestPlanIds,
	renderMatrix,
	scanTestTitles,
	type TraceInput,
	verify,
} from "../../../scripts/lib/traceability";

// Ids de teste montados em tempo de execução: o varredor de `test/` não pode ver um id literal aqui.
const id = (kind: string, n: number) =>
	`TST-${kind}-${String(n).padStart(2, "0")}`;

const REQUIREMENTS_MD = [
	"## 1. Money",
	"| ID | Requisito | Critério | Origem | Testes |",
	"|---|---|---|---|---|",
	`| RF-MNY-01 | Imutável | texto | §6.1 | ${id("U", 1)}, ${id("U", 2)} |`,
	`| RF-TXN-01 | Ciclo \\| de vida | A \\| B | §6.3 | ${id("U", 4)} |`,
	"| RF-AUT-01 | Sem auth | guard | §2 | revisão |",
	"## 11. Não funcionais",
	"| ID | Requisito | Critério |",
	"|---|---|---|",
	"| RNF-01 | TypeScript estrito | `typecheck` limpo |",
	`| RNF-02 | Migrations | ${id("I", 1)} |`,
].join("\n");

describe("T-062 check-traceability", () => {
	test("parses requirement rows, their area and the tests they cite (escaped pipes included)", () => {
		const reqs = parseRequirements(REQUIREMENTS_MD);
		expect(reqs.map((r) => r.id)).toEqual([
			"RF-MNY-01",
			"RF-TXN-01",
			"RF-AUT-01",
			"RNF-01",
			"RNF-02",
		]);
		expect(reqs[0]).toMatchObject({
			area: "1. Money",
			tests: [id("U", 1), id("U", 2)],
		});
		expect(reqs[1]?.text).toBe("Ciclo | de vida");
		expect(reqs[1]?.tests).toEqual([id("U", 4)]);
		expect(reqs[2]?.tests).toEqual([]);
		expect(reqs[4]?.tests).toEqual([id("I", 1)]);
	});

	test("parses the ids of the test plan tables", () => {
		const md = `| ${id("U", 1)} | cenário | RF |\n| ${id("C", 12)} | outro | RF |\ntexto ${id("I", 5)} solto`;
		expect(parseTestPlanIds(md)).toEqual([id("U", 1), id("C", 12)]);
	});

	test("parses tasks with their checkbox, keeping stretch tasks apart by id", () => {
		const md = [
			"- [x] **T-010** `Money`. *(RF-MNY-01..04)*",
			"- [ ] **T-063** Passada final.",
			"- [ ] **S-01** `test:load`.",
		].join("\n");
		expect(parseTasks(md)).toEqual([
			{ id: "T-010", done: true, text: "`Money`. *(RF-MNY-01..04)*" },
			{ id: "T-063", done: false, text: "Passada final." },
			{ id: "S-01", done: false, text: "`test:load`." },
		]);
	});

	test("reads test ids in the long and the shorthand forms, ranges included", () => {
		expect(
			extractTstIds(
				`(RF-MNY-01; ${id("U", 1)}, U-02) e C-04, C-05 e I-01..I-03`,
			),
		).toEqual(
			[
				id("U", 1),
				id("U", 2),
				id("C", 4),
				id("C", 5),
				id("I", 1),
				id("I", 2),
				id("I", 3),
			].sort(),
		);
	});

	test("does not read requirement ids as test ids", () => {
		expect(
			extractTstIds("RF-REC-01, RF-API-01, RF-CON-04, ADR-0010, T-026"),
		).toEqual([]);
	});

	const known = [
		"RF-MNY-01",
		"RF-MNY-02",
		"RF-MNY-03",
		"RF-MNY-04",
		"RF-LED-01",
		"RF-LED-02",
		"RF-TXN-06",
		"RF-TXN-07",
		"RF-TXN-08",
		"RF-TXN-09",
		"RF-TXN-11",
		"RF-TXN-03",
		"RF-WAL-03",
		"RF-WAL-04",
		"RNF-01",
		"RNF-03",
	];

	test("expands ranges, slashes, comma continuations, wildcards and RNF", () => {
		expect(expandRequirementRefs("(RF-MNY-01..04; x)", known)).toEqual([
			"RF-MNY-01",
			"RF-MNY-02",
			"RF-MNY-03",
			"RF-MNY-04",
		]);
		expect(expandRequirementRefs("(RF-WAL-03/04, RF-LED-*)", known)).toEqual([
			"RF-LED-01",
			"RF-LED-02",
			"RF-WAL-03",
			"RF-WAL-04",
		]);
		expect(expandRequirementRefs("(RF-TXN-06..09, 11; x)", known)).toEqual([
			"RF-TXN-06",
			"RF-TXN-07",
			"RF-TXN-08",
			"RF-TXN-09",
			"RF-TXN-11",
		]);
		expect(expandRequirementRefs("(RNF-01, RNF-03)", known)).toEqual([
			"RNF-01",
			"RNF-03",
		]);
	});

	test("finds ids in test titles, including titles of test.each, and ignores comments", () => {
		const files = {
			"test/unit/a.test.ts": [
				`test("${id("U", 1)} accepts a value", () => {});`,
				`// ${id("U", 2)} só num comentário`,
				`\t])(\`${id("U", 3)} rejects %s\`, () => {});`,
				`const note = "sem id";`,
			].join("\n"),
			"test/unit/b.test.ts": `describe('${id("U", 1)} again', () => {});`,
		};
		const found = scanTestTitles(files);
		expect(found.get(id("U", 1))).toEqual([
			"test/unit/a.test.ts",
			"test/unit/b.test.ts",
		]);
		expect(found.get(id("U", 3))).toEqual(["test/unit/a.test.ts"]);
		expect(found.has(id("U", 2))).toBe(false);
	});

	const input = (over: Partial<TraceInput> = {}): TraceInput => ({
		requirements: [
			{
				id: "RF-MNY-01",
				area: "1. Money",
				text: "Imutável",
				tests: [id("U", 1), id("U", 2)],
			},
			{ id: "RF-AUT-01", area: "10. API", text: "Sem auth", tests: [] },
		],
		planIds: [id("U", 1), id("U", 2)],
		tasks: [{ id: "T-010", done: true, text: `*(RF-MNY-01; ${id("U", 1)})*` }],
		found: new Map([
			[id("U", 1), ["test/unit/a.test.ts"]],
			[id("U", 2), ["test/unit/a.test.ts"]],
		]),
		...over,
	});

	test("a complete input has no violation (RF-AUT-01 is covered by the non-test map)", () => {
		expect(NON_TEST_VERIFICATION["RF-AUT-01"]).toBeDefined();
		expect(verify(input())).toEqual([]);
	});

	test("a requirement whose tests are all gone is a violation; one surviving test is enough", () => {
		const one = new Map([[id("U", 1), ["test/unit/a.test.ts"]]]);
		expect(verify(input({ found: one }))).toEqual([
			expect.stringContaining(id("U", 2)),
		]);
		const none = verify(input({ found: new Map() }));
		expect(
			none.some((p) => p.includes("RF-MNY-01") && /no test/i.test(p)),
		).toBe(true);
	});

	test("a test of the plan that no test cites is a violation", () => {
		const problems = verify(
			input({ planIds: [id("U", 1), id("U", 2), id("U", 9)] }),
		);
		expect(problems).toEqual([expect.stringContaining(id("U", 9))]);
	});

	test("a requirement citing a test that the plan does not define is a violation", () => {
		const reqs = input().requirements.map((r) =>
			r.id === "RF-MNY-01" ? { ...r, tests: [id("U", 1), id("U", 77)] } : r,
		);
		expect(verify(input({ requirements: reqs }))).toEqual([
			expect.stringContaining(id("U", 77)),
		]);
	});

	test("a requirement with no test and no non-test verification is a silent hole", () => {
		const reqs = [
			...input().requirements,
			{ id: "RF-XXX-01", area: "x", text: "sem prova", tests: [] },
		];
		expect(verify(input({ requirements: reqs }))).toEqual([
			expect.stringContaining("RF-XXX-01"),
		]);
	});

	test("an open T task is a violation, unless allowed; an open stretch task is not", () => {
		const tasks = [
			{ id: "T-010", done: true, text: "" },
			{ id: "T-063", done: false, text: "" },
			{ id: "S-01", done: false, text: "" },
		];
		expect(verify(input({ tasks }))).toEqual([
			expect.stringContaining("T-063"),
		]);
		expect(verify(input({ tasks }), { allowOpen: ["T-063"] })).toEqual([]);
	});

	test("the matrix is deterministic and maps requirement → task → test file, listing the stretch as not implemented", () => {
		const tasks = [
			{ id: "T-010", done: true, text: `*(RF-MNY-01; ${id("U", 1)})*` },
			{ id: "S-01", done: false, text: "`test:load`." },
		];
		const a = renderMatrix(input({ tasks }));
		expect(a).toBe(renderMatrix(input({ tasks })));
		expect(a).toContain("RF-MNY-01");
		expect(a).toContain("T-010");
		expect(a).toContain("test/unit/a.test.ts");
		expect(a).toMatch(/S-01.*não implementado, documentado/);
		expect(a).toContain("RF-AUT-01");
		expect(a).toContain(NON_TEST_VERIFICATION["RF-AUT-01"] ?? "?");
	});
});
