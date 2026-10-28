import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const repoRoot = join(import.meta.dir, "..", "..");

export type LintResult = { exitCode: number; output: string };

// Copia o fixture (.txt) para um .ts temporário e roda o Biome com a configuração REAL do repositório.
export async function lintFixture(
	name: string,
	extraConfig?: (config: Record<string, unknown>) => void,
): Promise<LintResult> {
	const dir = mkdtempSync(join(tmpdir(), "biome-fixture-"));
	const source = readFileSync(
		join(repoRoot, "test/support/fixtures/lint", `${name}.ts.txt`),
		"utf8",
	);
	writeFileSync(join(dir, "fixture.ts"), source);
	writeFileSync(join(dir, "repo.ts"), "export class Repo { size = 0; }\n");

	const config = JSON.parse(
		readFileSync(join(repoRoot, "biome.jsonc"), "utf8").replace(
			/^\s*\/\/.*$/gm,
			"",
		),
	) as Record<string, unknown>;
	config.files = { ignoreUnknown: false };
	config.vcs = { enabled: false };
	extraConfig?.(config);
	writeFileSync(join(dir, "biome.json"), JSON.stringify(config));

	const proc = Bun.spawn(
		[join(repoRoot, "node_modules/.bin/biome"), "lint", "fixture.ts"],
		{ cwd: dir, stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, output: stdout + stderr };
}
