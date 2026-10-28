import { describe, expect, test } from "bun:test";
import {
	checkAdrCitations,
	checkLinks,
	checkSections,
	extractLinks,
	githubSlug,
	REQUIRED_SECTIONS,
	type RequiredSection,
} from "../../../scripts/lib/architecture-check";

const section = (
	number: number,
	keyword: string,
	extra: Partial<RequiredSection> = {},
): RequiredSection => ({
	number,
	keyword,
	mustMention: [],
	needsDiagram: false,
	...extra,
});

describe("T-061 check-architecture", () => {
	test("the real list has the 15 mandatory sections of the wave, in order", () => {
		expect(REQUIRED_SECTIONS.map((s) => s.number)).toEqual(
			Array.from({ length: 15 }, (_, i) => i + 1),
		);
		const orm = REQUIRED_SECTIONS.find((s) => s.number === 2);
		expect(orm?.mustMention).toEqual(
			expect.arrayContaining(["NUMERIC(19,2)", "READ COMMITTED"]),
		);
		const locks = REQUIRED_SECTIONS.find((s) => s.number === 4);
		expect(locks?.needsDiagram).toBe(true);
		const rule4 = REQUIRED_SECTIONS.find((s) => s.number === 10);
		expect(rule4?.mustMention).toEqual(
			expect.arrayContaining(["ADR-0010", "regra 4"]),
		);
	});

	test("a document with every section passes", () => {
		const doc = "## 1. Visão geral\ncorpo\n## 2. ORM e Money\ncorpo\n";
		expect(
			checkSections(doc, [section(1, "visão geral"), section(2, "orm")]),
		).toEqual([]);
	});

	test("a missing section is reported by number", () => {
		const doc = "## 1. Visão geral\ncorpo\n";
		const problems = checkSections(doc, [
			section(1, "visão geral"),
			section(2, "orm"),
		]);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(/section 2/);
	});

	test("a section whose heading has the number but not the keyword is missing", () => {
		const problems = checkSections("## 2. Outra coisa\ncorpo\n", [
			section(2, "orm"),
		]);
		expect(problems[0]).toMatch(/section 2/);
	});

	test("an empty section body is reported", () => {
		const problems = checkSections("## 1. Visão geral\n\n## 2. ORM\ncorpo\n", [
			section(1, "visão geral"),
			section(2, "orm"),
		]);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(/section 1.*empty/i);
	});

	test("required terms must appear inside the section itself, not elsewhere", () => {
		const doc = "## 1. A\nNUMERIC(19,2)\n## 2. ORM\nsem o termo\n";
		const problems = checkSections(doc, [
			section(1, "a"),
			section(2, "orm", { mustMention: ["NUMERIC(19,2)"] }),
		]);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(/section 2.*NUMERIC\(19,2\)/);
	});

	test("a section that needs a diagram has a fenced block", () => {
		const without = checkSections("## 4. Locks\ntexto\n", [
			section(4, "locks", { needsDiagram: true }),
		]);
		expect(without[0]).toMatch(/section 4.*diagram/i);
		const withIt = checkSections(
			"## 4. Locks\n```mermaid\nflowchart LR\n```\n",
			[section(4, "locks", { needsDiagram: true })],
		);
		expect(withIt).toEqual([]);
	});

	test("headings inside fenced code are not sections", () => {
		const doc = "```\n## 2. ORM\n```\n## 1. A\ncorpo\n";
		expect(checkSections(doc, [section(2, "orm")])[0]).toMatch(/section 2/);
	});

	test("github slugs: lowercase, punctuation out, spaces to hyphens, accents kept", () => {
		expect(githubSlug("9. Taxonomia de `failureCode` e status HTTP")).toBe(
			"9-taxonomia-de-failurecode-e-status-http",
		);
		expect(githubSlug("Referências fora de ordem")).toBe(
			"referências-fora-de-ordem",
		);
	});

	test("extracts relative links with their line and skips external ones and code", () => {
		const doc = [
			"[a](specs/x.md) e [b](https://example.com) e [c](#local)",
			"```",
			"[nao](specs/dentro-do-codigo.md)",
			"```",
			"`[nao](specs/inline.md)` e [d](specs/y.md#sec)",
		].join("\n");
		expect(extractLinks(doc)).toEqual([
			{ target: "specs/x.md", line: 1 },
			{ target: "#local", line: 1 },
			{ target: "specs/y.md#sec", line: 5 },
		]);
	});

	const env = (files: Record<string, string>) => ({
		fileExists: (path: string) => path in files,
		readFile: (path: string) => files[path] ?? "",
	});

	test("a link to a missing file is reported with its line", () => {
		const problems = checkLinks(
			"ok\n[x](specs/nao-existe.md)\n",
			"/repo",
			env({}),
		);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(/line 2.*specs\/nao-existe\.md/);
	});

	test("an existing file and an existing anchor pass; a missing anchor is reported", () => {
		const files = { "/repo/specs/a.md": "# Titulo\n## 3. Seção Três\n" };
		expect(
			checkLinks("[x](specs/a.md#3-seção-três)", "/repo", env(files)),
		).toEqual([]);
		const bad = checkLinks("[x](specs/a.md#nao-tem)", "/repo", env(files));
		expect(bad).toHaveLength(1);
		expect(bad[0]).toMatch(/anchor/i);
	});

	test("a same-document anchor is checked against the document's own headings", () => {
		expect(checkLinks("# T\n## Um\n[x](#um)\n", "/repo", env({}))).toEqual([]);
		expect(
			checkLinks("# T\n## Um\n[x](#dois)\n", "/repo", env({})),
		).toHaveLength(1);
	});

	test("every cited ADR must have a file", () => {
		const files = ["0006-concorrencia-lock-pessimista.md"];
		expect(checkAdrCitations("veja ADR-0006 e a [nota](x)", files)).toEqual([]);
		const problems = checkAdrCitations("ADR-0006 e ADR-0099", files);
		expect(problems).toEqual([expect.stringContaining("ADR-0099")]);
	});
});
