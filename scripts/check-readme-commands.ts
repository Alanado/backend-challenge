import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkLinks } from "./lib/architecture-check";
import {
	candidateSection,
	extractBunRunTargets,
	findInvalidTargets,
	findMissingRequired,
	REQUIRED_COMMANDS,
} from "./lib/readme-commands";

// T-060: todo `bun run <script>` da seção do candidato no README.md existe no package.json (ou é um
// arquivo que existe), e os comandos obrigatórios estão lá. Sai com 1 no primeiro desvio.
const root = join(import.meta.dir, "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
	scripts?: Record<string, string>;
};

const candidate = candidateSection(readme);
const targets = extractBunRunTargets(candidate);
const invalid = findInvalidTargets(targets, pkg.scripts ?? {}, (path) =>
	existsSync(join(root, path)),
);
const missing = findMissingRequired(targets, REQUIRED_COMMANDS);
// Links relativos da seção do candidato (arquivos e âncoras do ARCHITECTURE.md): mesma conferência.
const brokenLinks = checkLinks(candidate, root, {
	fileExists: existsSync,
	readFile: (path) => readFileSync(path, "utf8"),
});

for (const target of targets) {
	console.log(
		`${invalid.includes(target) ? "FAIL" : "ok  "} bun run ${target}`,
	);
}
for (const command of missing) {
	console.log(`FAIL required command not in the README: bun run ${command}`);
}
for (const problem of brokenLinks) console.log(`FAIL README ${problem}`);
if (invalid.length > 0 || missing.length > 0 || brokenLinks.length > 0) {
	console.error(
		`check-readme-commands FAILED: ${invalid.length} unknown target(s), ${missing.length} required command(s) missing, ${brokenLinks.length} broken link(s)`,
	);
	process.exit(1);
}
console.log(`check-readme-commands ok (${targets.length} commands)`);
