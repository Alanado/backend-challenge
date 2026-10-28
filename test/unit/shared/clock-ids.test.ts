import { describe, expect, test } from "bun:test";
import { SystemClock } from "../../../src/shared/clock";
import { Uuidv7Generator } from "../../../src/shared/ids";

describe("shared Clock and id generator", () => {
	test("SystemClock returns the current instant", () => {
		const before = Date.now();
		const now = new SystemClock().now().getTime();
		expect(now).toBeGreaterThanOrEqual(before);
		expect(now).toBeLessThanOrEqual(Date.now());
	});

	test("Uuidv7Generator returns unique version-7 UUIDs", () => {
		const generator = new Uuidv7Generator();
		const ids = Array.from({ length: 100 }, () => generator.next());
		expect(new Set(ids).size).toBe(100);
		for (const id of ids) {
			expect(id).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			);
		}
	});
});
