import { describe, expect, test } from "bun:test";
import { eventually } from "../../support/eventually";

describe("eventually", () => {
	test("X-20 returns the value immediately when the condition already holds", async () => {
		const started = performance.now();
		const value = await eventually(() => "ready", {
			timeout: 2000,
			interval: 300,
		});
		expect(value).toBe("ready");
		// No fixed wait: a first-try success must not pay one polling interval.
		expect(performance.now() - started).toBeLessThan(100);
	});

	test("X-21 resolves shortly after the condition turns true", async () => {
		let flipAt = 0;
		const started = performance.now();
		flipAt = started + 60;
		const value = await eventually(
			() => {
				if (performance.now() < flipAt) throw new Error("not yet");
				return 7;
			},
			{ timeout: 2000, interval: 10 },
		);
		const elapsed = performance.now() - started;
		expect(value).toBe(7);
		expect(elapsed).toBeGreaterThanOrEqual(55);
		expect(elapsed).toBeLessThan(500);
	});

	test("X-22 supports async conditions", async () => {
		let calls = 0;
		const value = await eventually(
			async () => {
				calls += 1;
				if (calls < 3) throw new Error("not yet");
				return calls;
			},
			{ timeout: 2000, interval: 5 },
		);
		expect(value).toBe(3);
	});

	test("X-23 treats a returned false as not ready yet", async () => {
		let calls = 0;
		await eventually(
			() => {
				calls += 1;
				return calls >= 3;
			},
			{ timeout: 2000, interval: 5 },
		);
		expect(calls).toBe(3);
	});

	test("X-24 times out with a message that includes the last error", async () => {
		let calls = 0;
		const started = performance.now();
		let message = "";
		try {
			await eventually(
				() => {
					calls += 1;
					throw new Error(`still failing #${calls}`);
				},
				{ timeout: 150, interval: 10 },
			);
		} catch (err) {
			message = (err as Error).message;
		}
		const elapsed = performance.now() - started;
		expect(message).toContain("timed out after 150ms");
		expect(message).toContain(`still failing #${calls}`);
		expect(calls).toBeGreaterThan(3);
		expect(elapsed).toBeLessThan(600);
	});

	test("X-25 times out naming the condition when it only returned false", async () => {
		await expect(
			eventually(() => false, { timeout: 50, interval: 5 }),
		).rejects.toThrow(/timed out after 50ms.*returned false/);
	});
});
