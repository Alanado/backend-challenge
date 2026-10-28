import { describe, expect, test } from "bun:test";
import {
	type ReferenceBackoffConfig,
	referenceBackoff,
} from "../../../src/modules/wagering/domain/reference-backoff";

// Defaults of ADR-0013: 6 attempts, base 5 s, factor 2, cap 300 s.
const defaults: ReferenceBackoffConfig = {
	maxAttempts: 6,
	baseMs: 5000,
	factor: 2,
	capMs: 300_000,
};
const lowest = () => 0;
const highest = () => 0.999_999_999;

describe("TST-U-10 reference backoff", () => {
	test("TST-U-10 the delay ceilings follow base * factor^attempt: 5, 10, 20, 40, 80, 160 s", () => {
		const ceilings = [0, 1, 2, 3, 4, 5].map((attempt) =>
			Math.round(referenceBackoff(attempt, defaults, highest)),
		);
		expect(ceilings).toEqual([5000, 10_000, 20_000, 40_000, 80_000, 160_000]);
	});

	test("TST-U-10 equal jitter: with random 0 the delay is exactly half of the ceiling", () => {
		const floors = [0, 1, 2, 3, 4, 5].map((attempt) =>
			referenceBackoff(attempt, defaults, lowest),
		);
		expect(floors).toEqual([2500, 5000, 10_000, 20_000, 40_000, 80_000]);
	});

	test("TST-U-10 random is mapped linearly: d/2 + random * d/2", () => {
		expect(referenceBackoff(0, defaults, () => 0.5)).toBe(3750);
		expect(referenceBackoff(3, defaults, () => 0.25)).toBe(25_000);
	});

	test("TST-U-10 jitter stays inside [d/2, d] for any random value", () => {
		for (let attempt = 0; attempt < 6; attempt++) {
			const ceiling = Math.min(5000 * 2 ** attempt, 300_000);
			for (const random of [0, 0.1, 0.33, 0.5, 0.77, 0.999]) {
				const delay = referenceBackoff(attempt, defaults, () => random);
				expect(delay).toBeGreaterThanOrEqual(ceiling / 2);
				expect(delay).toBeLessThanOrEqual(ceiling);
			}
		}
	});

	test("TST-U-10 the cap limits the ceiling before the jitter is applied", () => {
		const capped: ReferenceBackoffConfig = { ...defaults, capMs: 30_000 };
		expect(referenceBackoff(4, capped, lowest)).toBe(15_000); // 80 s capped to 30 s, halved
		expect(referenceBackoff(5, capped, () => 0.5)).toBe(22_500);
		expect(referenceBackoff(40, defaults, () => 0.5)).toBe(225_000); // 300 s cap, no overflow
	});

	test("TST-U-10 the configuration is honoured (milliseconds in tests)", () => {
		const fast: ReferenceBackoffConfig = {
			maxAttempts: 3,
			baseMs: 10,
			factor: 3,
			capMs: 100,
		};
		expect(
			[0, 1, 2, 3].map((attempt) => referenceBackoff(attempt, fast, highest)),
		).toEqual([10, 30, 90, 100].map((v) => expect.closeTo(v, 3)));
	});

	test("TST-U-10 the default random source is Math.random and stays inside the window", () => {
		const delay = referenceBackoff(1, defaults);
		expect(delay).toBeGreaterThanOrEqual(5000);
		expect(delay).toBeLessThanOrEqual(10_000);
	});

	test("TST-U-10 an attempt that is not a non-negative integer is a programming error", () => {
		expect(() => referenceBackoff(-1, defaults, lowest)).toThrow(RangeError);
		expect(() => referenceBackoff(1.5, defaults, lowest)).toThrow(RangeError);
		expect(() => referenceBackoff(Number.NaN, defaults, lowest)).toThrow(
			RangeError,
		);
	});
});
