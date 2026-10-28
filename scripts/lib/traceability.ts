export interface Requirement {
	id: string;
	/** Título da seção do 01-requirements em que a linha aparece (sem o `## `). */
	area: string;
	text: string;
	tests: string[];
}

export interface Task {
	id: string;
	done: boolean;
	text: string;
}

export interface TraceInput {
	requirements: Requirement[];
	/** Todos os `TST-*` das tabelas do 05-test-plan. */
	planIds: string[];
	tasks: Task[];
	/** TST-id → arquivos de teste cujo título o cita. */
	found: Map<string, string[]>;
}

/**
 * Requisitos sem `TST-*` (o 01-requirements os prova por comando ou revisão). Declarados aqui para
 * que um requisito sem prova nenhuma seja um buraco acusado, e não silencioso.
 */
export const NON_TEST_VERIFICATION: Readonly<Record<string, string>> = {
	"RNF-01": "`bun run typecheck` (tsc estrito, `noUncheckedIndexedAccess`)",
	"RNF-03":
		"`docker compose up --build` e `bun run compose:smoke` (3 instâncias, exit 0)",
	"RNF-04": "medição de RAM em specs/adr/0002-spike.md (R-06)",
	"RNF-05": "commitlint no hook `commit-msg` (um commit por tarefa)",
	"RNF-06":
		"`scripts/check-readme-commands.ts` e `scripts/check-architecture.ts`",
	"RF-AUT-01":
		"revisão: `AuthGuard` no-op e `ProviderIdentityPort` (ADR-0017); health e `/metrics` abertos",
};

const TST_ID = /TST-[UIC]-\d{2}/g;
const UNESCAPED_PIPE = /(?<!\\)\|/;

const sorted = (values: Iterable<string>): string[] =>
	[...new Set(values)].sort();

function cellsOf(line: string): string[] | undefined {
	if (!line.startsWith("|")) return undefined;
	const parts = line.split(UNESCAPED_PIPE).map((cell) => cell.trim());
	return parts.slice(1, parts.at(-1) === "" ? -1 : undefined);
}

export function parseRequirements(markdown: string): Requirement[] {
	const found: Requirement[] = [];
	let area = "";
	for (const line of markdown.split("\n")) {
		const heading = /^##\s+(.*\S)\s*$/.exec(line);
		if (heading?.[1] !== undefined) {
			area = heading[1];
			continue;
		}
		const cells = cellsOf(line);
		const id = cells?.[0];
		if (cells === undefined || id === undefined) continue;
		if (!/^(RF-[A-Z]{3}|RNF)-\d{2}$/.test(id)) continue;
		// RF: coluna "Testes" (a quinta); RNF: o critério (a terceira) cita o teste.
		const testCells = cells.length >= 5 ? [cells[4] ?? ""] : cells.slice(2);
		found.push({
			id,
			area,
			text: (cells[1] ?? "").replaceAll("\\|", "|"),
			tests: sorted(testCells.join(" ").match(TST_ID) ?? []),
		});
	}
	return found;
}

export function parseTestPlanIds(markdown: string): string[] {
	const ids: string[] = [];
	for (const line of markdown.split("\n")) {
		const first = cellsOf(line)?.[0];
		if (first !== undefined && /^TST-[UIC]-\d{2}$/.test(first)) ids.push(first);
	}
	return ids;
}

export function parseTasks(markdown: string): Task[] {
	const tasks: Task[] = [];
	for (const line of markdown.split("\n")) {
		const match = /^- \[( |x)\] \*\*([TS]-\d{2,3}[a-z]?)\*\*\s*(.*)$/.exec(
			line,
		);
		if (match?.[2] === undefined) continue;
		tasks.push({
			id: match[2],
			done: match[1] === "x",
			text: match[3] ?? "",
		});
	}
	return tasks;
}

// `TST-U-01`, o atalho `U-02` das tarefas e as faixas `I-01..I-03`. O lookbehind impede casar o
// final de `RF-REC-01` ou `RF-API-01` como se fosse `C-01` ou `I-01`.
const TST_LOOSE =
	/(?<![A-Za-z0-9])(?:TST-)?([UIC])-(\d{2})(?:\.\.(?:TST-)?(?:[UIC]-)?(\d{2}))?/g;

/** Ids de teste citados num texto de tarefa, nas formas longa e abreviada. */
export function extractTstIds(text: string): string[] {
	const ids: string[] = [];
	for (const match of text.matchAll(TST_LOOSE)) {
		const kind = match[1];
		const from = Number(match[2]);
		const to = match[3] === undefined ? from : Number(match[3]);
		for (let n = from; n <= to; n++) {
			ids.push(`TST-${kind}-${String(n).padStart(2, "0")}`);
		}
	}
	return sorted(ids);
}

const RF_REF =
	/\bRF-([A-Z]{3})-(\*|\d{2})((?:(?:\.\.|\/|,\s)\d{2}(?![\d-]))*)/g;

/** `RF-*`/`RNF-*` citados num texto (faixas `..`, `/`, continuação `, 11` e `RF-LED-*`), só os que existem. */
export function expandRequirementRefs(
	text: string,
	knownIds: readonly string[],
): string[] {
	const wanted: string[] = [];
	for (const match of text.matchAll(/\bRNF-(\d{2})\b/g)) {
		wanted.push(`RNF-${match[1]}`);
	}
	for (const match of text.matchAll(RF_REF)) {
		const area = match[1] as string;
		const first = match[2] as string;
		if (first === "*") {
			wanted.push(...knownIds.filter((id) => id.startsWith(`RF-${area}-`)));
			continue;
		}
		let previous = Number(first);
		wanted.push(`RF-${area}-${first}`);
		for (const part of (match[3] ?? "").matchAll(/(\.\.|\/|,\s)(\d{2})/g)) {
			const n = Number(part[2]);
			const start = part[1] === ".." ? previous + 1 : n;
			for (let i = start; i <= n; i++) {
				wanted.push(`RF-${area}-${String(i).padStart(2, "0")}`);
			}
			previous = n;
		}
	}
	return sorted(wanted.filter((id) => knownIds.includes(id)));
}

const STRING_LITERAL = /(["'`])(?:\\.|(?!\1)[^\\])*\1/g;

/**
 * Varre o código de teste atrás de `TST-*` em literais de texto (títulos de `describe`/`test`, também
 * os de `test.each`, que ficam em linha própria). Linhas de comentário não contam.
 */
export function scanTestTitles(
	files: Readonly<Record<string, string>>,
): Map<string, string[]> {
	const found = new Map<string, string[]>();
	for (const path of Object.keys(files).sort()) {
		for (const line of (files[path] ?? "").split("\n")) {
			const trimmed = line.trimStart();
			if (/^(\/\/|\/\*|\*)/.test(trimmed)) continue;
			for (const literal of line.matchAll(STRING_LITERAL)) {
				for (const id of literal[0].match(TST_ID) ?? []) {
					const paths = found.get(id) ?? [];
					if (!paths.includes(path)) paths.push(path);
					found.set(id, paths);
				}
			}
		}
	}
	return found;
}

export function verify(
	input: TraceInput,
	options: { allowOpen?: readonly string[] } = {},
): string[] {
	const problems: string[] = [];
	const plan = new Set(input.planIds);

	for (const id of input.planIds) {
		if (!input.found.has(id)) {
			problems.push(`${id} is in the test plan but no test title cites it`);
		}
	}
	for (const requirement of input.requirements) {
		for (const id of requirement.tests) {
			if (!plan.has(id)) {
				problems.push(
					`${requirement.id} cites ${id}, which the test plan does not define`,
				);
			}
		}
		if (requirement.tests.length > 0) {
			if (!requirement.tests.some((id) => input.found.has(id))) {
				problems.push(
					`${requirement.id} has no test in the code (cites ${requirement.tests.join(", ")})`,
				);
			}
		} else if (NON_TEST_VERIFICATION[requirement.id] === undefined) {
			problems.push(
				`${requirement.id} has no TST-* and no declared verification: a silent hole`,
			);
		}
	}
	for (const task of input.tasks) {
		if (task.id.startsWith("T-") && !task.done) {
			if (options.allowOpen?.includes(task.id)) continue;
			problems.push(`task ${task.id} is still open ([ ])`);
		}
	}
	return problems;
}

const link = (path: string): string =>
	`[${path.split("/").at(-1)}](../${path})`;

/** specs/traceability.md: arquivo gerado, determinístico (sem data), regenerável. */
export function renderMatrix(input: TraceInput): string {
	const known = input.requirements.map((r) => r.id);
	const tasksOf = (requirement: Requirement): string[] =>
		input.tasks
			.filter((task) => task.id.startsWith("T-"))
			.filter(
				(task) =>
					expandRequirementRefs(task.text, known).includes(requirement.id) ||
					extractTstIds(task.text).some((id) => requirement.tests.includes(id)),
			)
			.map((task) => task.id);

	const testCell = (requirement: Requirement): string => {
		if (requirement.tests.length === 0) {
			return `${NON_TEST_VERIFICATION[requirement.id] ?? "sem verificação declarada"} (sem TST)`;
		}
		return requirement.tests
			.map((id) => {
				const files = input.found.get(id);
				return files === undefined
					? `${id} (AUSENTE)`
					: `${id}: ${files.map(link).join(", ")}`;
			})
			.join("<br>");
	};

	const withTest = input.requirements.filter((r) => r.tests.length > 0).length;
	const lines: string[] = [
		"# Matriz de rastreabilidade",
		"",
		"> Arquivo **gerado** por `bun scripts/check-traceability.ts` a partir de `01-requirements.md`, `05-test-plan.md`, `06-tasks.md` e dos títulos em `test/`. Não edite à mão: rode o script para regenerar. Sem data de propósito (a saída é determinística).",
		"",
		"## Resumo",
		"",
		`- Requisitos: ${input.requirements.length} (${withTest} com \`TST-*\`, ${input.requirements.length - withTest} com verificação por comando ou revisão).`,
		`- Testes do plano: ${input.planIds.length}; citados em títulos de teste: ${input.planIds.filter((id) => input.found.has(id)).length}.`,
		`- Tarefas T: ${input.tasks.filter((t) => t.id.startsWith("T-") && t.done).length} de ${input.tasks.filter((t) => t.id.startsWith("T-")).length} concluídas.`,
		"",
		"## Requisito → tarefa → teste",
		"",
		"Tarefas = as que citam o requisito ou um dos seus testes (06-tasks). Testes = `TST-*` citados no requisito, com os arquivos cujos títulos os contêm.",
	];
	let area: string | undefined;
	for (const requirement of input.requirements) {
		if (requirement.area !== area) {
			area = requirement.area;
			lines.push(
				"",
				`### ${area}`,
				"",
				"| Requisito | Tarefas | Testes → arquivos |",
				"|---|---|---|",
			);
		}
		const tasks = tasksOf(requirement);
		lines.push(
			`| **${requirement.id}** ${requirement.text} | ${tasks.length === 0 ? "—" : tasks.join(", ")} | ${testCell(requirement)} |`,
		);
	}

	lines.push(
		"",
		"## Teste → arquivos",
		"",
		"| Teste | Arquivos |",
		"|---|---|",
	);
	for (const id of [...input.planIds].sort()) {
		const files = input.found.get(id);
		lines.push(
			`| ${id} | ${files === undefined ? "AUSENTE" : files.map(link).join(", ")} |`,
		);
	}

	const stretch = input.tasks.filter((t) => t.id.startsWith("S-"));
	lines.push("", "## Tarefas", "");
	for (const task of input.tasks.filter((t) => t.id.startsWith("T-"))) {
		lines.push(`- ${task.done ? "[x]" : "[ ]"} **${task.id}** ${task.text}`);
	}
	lines.push(
		"",
		"## Não implementado, documentado (stretch)",
		"",
		"Fora do escopo obrigatório; nenhum requisito RF/RNF depende destas tarefas. A linha de corte (M4) não foi usada: todas as tarefas T, inclusive a T-044, estão concluídas.",
		"",
	);
	for (const task of stretch) {
		lines.push(
			`- **${task.id}** ${task.text} — ${task.done ? "concluído" : "não implementado, documentado"}`,
		);
	}
	return `${lines.join("\n")}\n`;
}
