import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	checkAdrCitations,
	checkLinks,
	checkSections,
	REQUIRED_SECTIONS,
} from "./lib/architecture-check";

// T-061: o ARCHITECTURE.md tem as 15 seções obrigatórias (e o que cada uma precisa dizer), todo
// link relativo resolve (arquivo e âncora) e todo ADR citado existe. Sai com 1 no primeiro desvio.
const root = join(import.meta.dir, "..");
const markdown = readFileSync(join(root, "ARCHITECTURE.md"), "utf8");

const problems = [
	...checkSections(markdown, REQUIRED_SECTIONS),
	...checkLinks(markdown, root, {
		fileExists: existsSync,
		readFile: (path) => readFileSync(path, "utf8"),
	}),
	...checkAdrCitations(markdown, readdirSync(join(root, "specs/adr"))),
];

for (const problem of problems) console.log(`FAIL ${problem}`);
if (problems.length > 0) {
	console.error(`check-architecture FAILED: ${problems.length} problem(s)`);
	process.exit(1);
}
console.log(
	`check-architecture ok (${REQUIRED_SECTIONS.length} sections, links and ADRs resolve)`,
);
