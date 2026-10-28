import { describe, expect, test } from "bun:test";
import { PollingLoop } from "../../../src/modules/platform/infrastructure/polling-loop";
import { eventually } from "../../support/eventually";

describe("PollingLoop", () => {
	test("PLP-01 stop() waits for the tick in progress and starts no other", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started = 0;
		let finished = 0;
		const loop = new PollingLoop(
			async () => {
				started += 1;
				await gate;
				finished += 1;
				return true;
			},
			10,
			() => {},
		);
		loop.start();
		await eventually(() => started === 1);

		let stopped = false;
		const stopping = loop.stop().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(stopped).toBe(false);

		release();
		await stopping;
		expect(finished).toBe(1);
		expect(started).toBe(1);
	});

	test("PLP-02 a tick that found work runs again at once; an idle one sleeps", async () => {
		let ticks = 0;
		const loop = new PollingLoop(
			async () => {
				ticks += 1;
				return ticks < 5;
			},
			60_000,
			() => {},
		);
		loop.start();
		await eventually(() => ticks === 5);
		await loop.stop();
		expect(ticks).toBe(5);
	});

	test("PLP-03 a throwing tick is reported and the loop keeps going", async () => {
		const errors: unknown[] = [];
		let ticks = 0;
		const loop = new PollingLoop(
			async () => {
				ticks += 1;
				if (ticks === 1) throw new Error("boom");
				return false;
			},
			5,
			(error) => errors.push(error),
		);
		loop.start();
		await eventually(() => ticks >= 3);
		await loop.stop();
		expect(errors).toHaveLength(1);
	});

	test("PLP-04 stop() wakes a sleeping loop immediately", async () => {
		let ticks = 0;
		const loop = new PollingLoop(
			async () => {
				ticks += 1;
				return false;
			},
			60_000,
			() => {},
		);
		loop.start();
		await eventually(() => ticks === 1);
		const startedAt = performance.now();
		await loop.stop();
		expect(performance.now() - startedAt).toBeLessThan(1000);
	});
});
