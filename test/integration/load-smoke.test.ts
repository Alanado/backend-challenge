import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REQUIRED_FIELDS = [
	"throughputPerSecond",
	"latency",
	"errorRate",
	"lockConflicts",
	"outboxLagMaxSeconds",
	"idempotentRequests",
	"transactions",
	"generatorCpuPercent",
] as const;

describe("TST-I-22 load test, smoke profile (real processes, real PostgreSQL and SQS)", () => {
	test("TST-I-22 `test:load --profile smoke` exits 0, prints every required column and the ledger invariant holds", async () => {
		const out = mkdtempSync(join(tmpdir(), "load-smoke-"));
		try {
			const proc = Bun.spawn(
				[
					process.execPath,
					"test/load/run.ts",
					"--profile",
					"smoke",
					"--out",
					out,
				],
				{
					cwd: `${import.meta.dir}/../..`,
					env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({
				code: 0,
				stderr: "",
			});

			for (const column of [
				"req/s",
				"p50 ms",
				"p95 ms",
				"p99 ms",
				"error %",
				"lock conflicts",
				"outbox lag max s",
			]) {
				expect(stdout).toContain(column);
			}
			expect(stdout).toContain("ledger invariant: OK");

			const files = readdirSync(out).filter((f) => f.endsWith(".json"));
			expect(files).toHaveLength(1);
			const report = JSON.parse(
				readFileSync(join(out, files[0] as string), "utf8"),
			);
			expect(report.profile).toBe("smoke");
			expect(report.environment.cpuCores).toBeGreaterThan(0);
			expect(report.instances).toBe(3);
			expect(report.results.map((r: { id: string }) => r.id)).toEqual([
				"N1",
				"N2",
				"N3",
				"N4",
			]);
			for (const result of report.results) {
				for (const field of REQUIRED_FIELDS) {
					expect(result).toHaveProperty(field);
				}
				expect(result.violations).toEqual([]);
				expect(result.unexpectedErrors).toBe(0);
				expect(result.latency.count).toBeGreaterThan(0);
				expect(result.latency.p50).toBeLessThanOrEqual(result.latency.p95);
				expect(result.latency.p95).toBeLessThanOrEqual(result.latency.p99);
			}
			expect(report.verification.violations).toEqual([]);
		} finally {
			rmSync(out, { recursive: true, force: true });
		}
	}, 180_000);
});
