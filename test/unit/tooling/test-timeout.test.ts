import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const MIN_DEFAULT_TIMEOUT_MS = 20_000;

// `[test] timeout` in bunfig.toml is not honoured by Bun 1.4.4 (measured in T-070), so the
// default timeout lives in the scripts that run the suites that start real processes.
const SUITES_WITH_REAL_INFRA = [
	"test:integration",
	"test:concurrency",
] as const;

const scripts = (
	JSON.parse(readFileSync("package.json", "utf8")) as {
		scripts: Record<string, string>;
	}
).scripts;

function effectiveTimeoutMs(script: string | undefined): number | null {
	const match = script?.match(/--timeout(?:=|\s+)(\d+)/);
	return match?.[1] ? Number(match[1]) : null;
}

describe("TST-U-14 default test timeout", () => {
	test("effectiveTimeoutMs reads the --timeout flag and tolerates its absence", () => {
		expect(effectiveTimeoutMs("bun test --timeout 30000 test/x")).toBe(30_000);
		expect(effectiveTimeoutMs("bun test --timeout=45000 test/x")).toBe(45_000);
		expect(effectiveTimeoutMs("bun test test/x")).toBeNull();
		expect(effectiveTimeoutMs(undefined)).toBeNull();
	});

	for (const name of SUITES_WITH_REAL_INFRA) {
		test(`${name} sets a default timeout of at least ${MIN_DEFAULT_TIMEOUT_MS} ms`, () => {
			const timeout = effectiveTimeoutMs(scripts[name]);
			expect(timeout).not.toBeNull();
			expect(timeout ?? 0).toBeGreaterThanOrEqual(MIN_DEFAULT_TIMEOUT_MS);
		});
	}
});
