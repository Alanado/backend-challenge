/** Fim da seção do candidato no README.md; abaixo dele fica o enunciado original, que não é conferido. */
export const CANDIDATE_END_MARKER =
	"<!-- fim da seção do candidato: abaixo, o enunciado original do desafio, sem alterações -->";

/** O que o README tem de ensinar: preparar a infra, migrar, rodar, testar em cada nível e o smoke das 3 instâncias. */
export const REQUIRED_COMMANDS: readonly string[] = [
	"test:infra:up",
	"test:infra:down",
	"migration:up",
	"queues:create",
	"dev",
	"test:unit",
	"test:integration",
	"test:concurrency",
	"test",
	"compose:smoke",
	"typecheck",
	"lint",
];

/** A parte do README escrita pelo candidato: tudo antes do marcador. Sem marcador é erro, nunca o arquivo inteiro. */
export function candidateSection(readme: string): string {
	const end = readme.indexOf(CANDIDATE_END_MARKER);
	if (end === -1) {
		throw new Error(
			`README.md has no end marker for the candidate section: ${CANDIDATE_END_MARKER}`,
		);
	}
	return readme.slice(0, end);
}

// `bun run <alvo>`: o alvo é um script do package.json ou um arquivo (`scripts/x.ts`).
const BUN_RUN = /\bbun run\s+([a-z][a-z0-9:_./-]*)(?=[\s`'")]|$)/gi;

/** Alvos de `bun run` citados no markdown, na ordem da primeira aparição e sem repetição. */
export function extractBunRunTargets(markdown: string): string[] {
	const found = new Set<string>();
	for (const match of markdown.matchAll(BUN_RUN)) {
		const target = match[1];
		if (target !== undefined) found.add(target);
	}
	return [...found];
}

const isFileTarget = (target: string): boolean =>
	target.includes("/") || /\.(ts|js|mjs)$/.test(target);

/** Alvos que não existem: script ausente do package.json ou arquivo inexistente. */
export function findInvalidTargets(
	targets: readonly string[],
	packageScripts: Readonly<Record<string, string>>,
	fileExists: (path: string) => boolean,
): string[] {
	return targets.filter((target) =>
		isFileTarget(target)
			? !fileExists(target)
			: !Object.hasOwn(packageScripts, target),
	);
}

/** Comandos obrigatórios que o README não menciona. */
export function findMissingRequired(
	targets: readonly string[],
	required: readonly string[],
): string[] {
	return required.filter((command) => !targets.includes(command));
}
