import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/lint";

async function runHook(
	message: string,
): Promise<{ exitCode: number; output: string }> {
	const file = join(
		mkdtempSync(join(tmpdir(), "commitmsg-")),
		"COMMIT_EDITMSG",
	);
	writeFileSync(file, `${message}\n`);
	const proc = Bun.spawn(["sh", join(repoRoot, ".githooks/commit-msg"), file], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, output: stdout + stderr };
}

describe("R-05 commit-msg hook (commitlint)", () => {
	test("R-05 accepts a Portuguese message with accents", async () => {
		const result = await runHook(
			"feat(wallet): adiciona validação de saldo e conciliação (T-010)",
		);
		expect(result.output).toBe("");
		expect(result.exitCode).toBe(0);
	});

	test("R-05 accepts the canonical example from CLAUDE.md", async () => {
		const result = await runHook(
			"feat(wagering): adiciona idempotência por chave (T-031b)",
		);
		expect(result.exitCode).toBe(0);
	});

	test("R-05 rejects a message without conventional type", async () => {
		const result = await runHook("adicionei umas coisas");
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain("type-empty");
	});

	test("R-05 rejects an unknown type", async () => {
		const result = await runHook("wip(wallet): rascunho (T-010)");
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain("type-enum");
	});

	test("R-05 rejects an empty subject", async () => {
		const result = await runHook("feat(wallet):");
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain("subject-empty");
	});

	test("R-05 rejects a capitalized subject with full stop", async () => {
		const result = await runHook("feat(wallet): Adiciona Money.");
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain("subject-case");
		expect(result.output).toContain("subject-full-stop");
	});

	test("R-05 rejects a Co-Authored-By trailer (project rule)", async () => {
		const result = await runHook(
			"feat(wallet): adiciona Money (T-010)\n\nCo-Authored-By: Alguém <a@b.c>",
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain("no-co-authored-by");
	});
});
