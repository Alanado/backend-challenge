import { resolve } from "node:path";

/** Uma seção obrigatória do ARCHITECTURE.md (W11, T-061): `## <número>. <título com a palavra-chave>`. */
export interface RequiredSection {
	number: number;
	/** Palavra-chave que o título da seção contém (sem diferenciar maiúsculas). */
	keyword: string;
	/** Termos que o corpo da própria seção precisa citar (sem diferenciar maiúsculas). */
	mustMention: readonly string[];
	needsDiagram: boolean;
}

const required = (
	number: number,
	keyword: string,
	mustMention: readonly string[] = [],
	needsDiagram = false,
): RequiredSection => ({ number, keyword, mustMention, needsDiagram });

export const REQUIRED_SECTIONS: readonly RequiredSection[] = [
	required(1, "visão geral", ["hexagonal"], true),
	required(2, "ORM", ["MikroORM", "NUMERIC(19,2)", "READ COMMITTED"]),
	required(3, "Concorrência", ["FOR UPDATE", "otimista", "single-writer"]),
	required(4, "Ordem canônica de locks", ["KEY SHARE"], true),
	required(5, "Idempotência", ["payloadHash", "SHA-256", "observed_balance"]),
	required(6, "Ledger imutável", ["trigger", "reconciliação"]),
	required(7, "Outbox", ["inbox", "DLQ", "breaker", "shutdown"]),
	required(8, "Referências fora de ordem", ["backoff"]),
	required(9, "Taxonomia", ["failureCode", "errorCode", "422"]),
	required(10, "Interpretações do enunciado", ["ADR-0010", "regra 4"]),
	required(11, "Autenticação", ["azp", "JWKS", "ProviderIdentityPort"]),
	required(12, "Observabilidade", ["playerId", "/metrics", "health"]),
	required(13, "Testes", ["TEST_FAULT", "Bun.spawn"]),
	required(14, "Limitações"),
	required(15, "Trade-offs", ["SNS", "DLQ"]),
];

export interface Link {
	target: string;
	line: number;
}

interface Heading {
	level: number;
	title: string;
	/** Índice da linha (0-based) do título. */
	index: number;
}

/** Âncora que o GitHub gera para um título: minúsculas, sem pontuação, espaços viram hífens. */
export function githubSlug(heading: string): string {
	return heading
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.replace(/\s/g, "-");
}

/** Linhas fora de blocos de código cercados (``` ou ~~~); as de dentro viram `undefined`. */
function proseLines(markdown: string): Array<string | undefined> {
	let fenced = false;
	return markdown.split("\n").map((line) => {
		if (/^\s*(```|~~~)/.test(line)) {
			fenced = !fenced;
			return undefined;
		}
		return fenced ? undefined : line;
	});
}

function headingsOf(markdown: string): Heading[] {
	const found: Heading[] = [];
	proseLines(markdown).forEach((line, index) => {
		const match =
			line === undefined ? null : /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
		if (match?.[1] !== undefined && match[2] !== undefined) {
			found.push({ level: match[1].length, title: match[2], index });
		}
	});
	return found;
}

const INLINE_LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Links `[texto](destino)` fora de código, exceto os externos (`https:`, `mailto:`…). */
export function extractLinks(markdown: string): Link[] {
	const links: Link[] = [];
	proseLines(markdown).forEach((line, index) => {
		if (line === undefined) return;
		const withoutCode = line.replace(/`[^`]*`/g, "");
		for (const match of withoutCode.matchAll(INLINE_LINK)) {
			const target = match[1];
			if (target === undefined || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
			links.push({ target, line: index + 1 });
		}
	});
	return links;
}

/** Corpo da seção: da linha seguinte ao título até o próximo título de nível ≤ 2. */
function bodyOf(markdown: string, heading: Heading, all: Heading[]): string {
	const next = all.find((h) => h.index > heading.index && h.level <= 2);
	const lines = markdown.split("\n");
	return lines.slice(heading.index + 1, next?.index ?? lines.length).join("\n");
}

export function checkSections(
	markdown: string,
	sections: readonly RequiredSection[],
): string[] {
	const headings = headingsOf(markdown);
	const problems: string[] = [];
	for (const section of sections) {
		const heading = headings.find(
			(h) =>
				h.level === 2 &&
				h.title.startsWith(`${section.number}. `) &&
				h.title.toLowerCase().includes(section.keyword.toLowerCase()),
		);
		if (heading === undefined) {
			problems.push(
				`section ${section.number} ("${section.keyword}") is missing: expected a "## ${section.number}. …" heading`,
			);
			continue;
		}
		const body = bodyOf(markdown, heading, headings);
		if (body.trim() === "") {
			problems.push(`section ${section.number} is empty`);
			continue;
		}
		for (const term of section.mustMention) {
			if (!body.toLowerCase().includes(term.toLowerCase())) {
				problems.push(`section ${section.number} does not mention "${term}"`);
			}
		}
		if (section.needsDiagram && !/^\s*(```|~~~)/m.test(body)) {
			problems.push(`section ${section.number} has no diagram (fenced block)`);
		}
	}
	return problems;
}

export interface LinkEnv {
	fileExists: (path: string) => boolean;
	readFile: (path: string) => string;
}

const slugsOf = (markdown: string): Set<string> =>
	new Set(headingsOf(markdown).map((h) => githubSlug(h.title)));

/** Todo link relativo aponta para um arquivo que existe e, se tiver `#âncora`, para um título que existe. */
export function checkLinks(
	markdown: string,
	baseDir: string,
	env: LinkEnv,
): string[] {
	const problems: string[] = [];
	const ownSlugs = slugsOf(markdown);
	for (const link of extractLinks(markdown)) {
		const hash = link.target.indexOf("#");
		const path = hash === -1 ? link.target : link.target.slice(0, hash);
		const anchor =
			hash === -1 ? "" : decodeURIComponent(link.target.slice(hash + 1));
		if (path === "") {
			if (anchor !== "" && !ownSlugs.has(anchor)) {
				problems.push(
					`line ${link.line}: anchor #${anchor} not found in this document`,
				);
			}
			continue;
		}
		const file = resolve(baseDir, path);
		if (!env.fileExists(file)) {
			problems.push(`line ${link.line}: link to missing file ${link.target}`);
			continue;
		}
		if (
			anchor !== "" &&
			file.endsWith(".md") &&
			!slugsOf(env.readFile(file)).has(anchor)
		) {
			problems.push(
				`line ${link.line}: anchor #${anchor} not found in ${path}`,
			);
		}
	}
	return problems;
}

/** Todo `ADR-nnnn` citado tem arquivo `<nnnn>-*.md` em `specs/adr/`. */
export function checkAdrCitations(
	markdown: string,
	adrFileNames: readonly string[],
): string[] {
	const cited = new Set(
		[...markdown.matchAll(/\bADR-(\d{4})\b/g)].map((m) => m[1]),
	);
	return [...cited]
		.filter((n) => !adrFileNames.some((name) => name.startsWith(`${n}-`)))
		.map((n) => `ADR-${n} is cited but specs/adr/${n}-*.md does not exist`);
}
