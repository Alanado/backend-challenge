import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import {
	parseRequirements,
	parseTasks,
	parseTestPlanIds,
	renderMatrix,
	scanTestTitles,
	verify,
} from "./lib/traceability";

// T-062: todo requisito com teste tem teste no código, todo TST do plano existe nos títulos, nenhuma
// tarefa T aberta; regenera specs/traceability.md. Sai com 1 no primeiro desvio.
//   --check               não escreve; falha também se specs/traceability.md estiver desatualizado
//   --allow-open=T-063    tolera tarefas abertas (só para o commit da própria tarefa anterior à última)
const root = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const allowOpen = args
	.filter((arg) => arg.startsWith("--allow-open="))
	.flatMap((arg) => arg.slice("--allow-open=".length).split(","));

const read = (path: string): string => readFileSync(join(root, path), "utf8");

const testFiles: Record<string, string> = {};
for await (const path of new Glob("test/**/*.ts").scan({ cwd: root })) {
	testFiles[path] = read(path);
}

const input = {
	requirements: parseRequirements(read("specs/01-requirements.md")),
	planIds: parseTestPlanIds(read("specs/05-test-plan.md")),
	tasks: parseTasks(read("specs/06-tasks.md")),
	found: scanTestTitles(testFiles),
};

const problems = verify(input, { allowOpen });
const matrix = renderMatrix(input);
const target = join(root, "specs/traceability.md");

if (checkOnly) {
	const current = existsSync(target) ? readFileSync(target, "utf8") : "";
	if (current !== matrix) {
		problems.push(
			"specs/traceability.md is out of date: run `bun scripts/check-traceability.ts`",
		);
	}
} else if (problems.length === 0) {
	writeFileSync(target, matrix);
}

for (const problem of problems) console.log(`FAIL ${problem}`);
if (problems.length > 0) {
	console.error(`check-traceability FAILED: ${problems.length} problem(s)`);
	process.exit(1);
}
console.log(
	`check-traceability ok (${input.requirements.length} requirements, ${input.planIds.length} tests, ${input.tasks.filter((t) => t.id.startsWith("T-")).length} tasks)${checkOnly ? "" : "; specs/traceability.md written"}`,
);
