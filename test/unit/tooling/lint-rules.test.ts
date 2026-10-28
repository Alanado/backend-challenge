import { describe, expect, test } from "bun:test";
import { lintFixture } from "../../support/lint";

describe("R-05 Biome rules", () => {
	test("R-05 a floating promise fails lint with noFloatingPromises", async () => {
		const result = await lintFixture("floating-promise");
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain("lint/nursery/noFloatingPromises");
	});

	test("R-05 awaited, voided and caught promises pass lint", async () => {
		const result = await lintFixture("handled-promise");
		expect(result.output).not.toContain("noFloatingPromises");
		expect(result.exitCode).toBe(0);
	});

	test("R-05 value imports used only as constructor types pass (useImportType off)", async () => {
		const result = await lintFixture("nest-di");
		expect(result.output).not.toContain("useImportType");
		expect(result.exitCode).toBe(0);
	});

	test("R-05 with useImportType on, the Nest DI import would be flagged (why it is off)", async () => {
		const result = await lintFixture("nest-di", (config) => {
			const linter = config.linter as { rules: Record<string, unknown> };
			linter.rules.style = { useImportType: "error" };
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain("useImportType");
	});
});
