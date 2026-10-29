import { describe, expect, test } from "bun:test";
import {
	LatencyRecorder,
	OutcomeTally,
	percentile,
	stopwatch,
	throughput,
} from "../../load/lib/measurement";

describe("TST-U-15 load measurement", () => {
	describe("percentiles (nearest-rank)", () => {
		const hundred = Array.from({ length: 100 }, (_, i) => i + 1);

		test("TST-U-15 p50, p95 and p99 of 1..100 are the 50th, 95th and 99th values", () => {
			expect(percentile(hundred, 50)).toBe(50);
			expect(percentile(hundred, 95)).toBe(95);
			expect(percentile(hundred, 99)).toBe(99);
			expect(percentile(hundred, 100)).toBe(100);
		});

		test("TST-U-15 is a value that was observed, not an average or an interpolation", () => {
			expect(percentile([10, 20, 30, 40], 50)).toBe(20);
			expect(percentile([10, 20, 30, 40], 75)).toBe(30);
			expect(percentile([1, 1, 1, 1000], 99)).toBe(1000);
		});

		test("TST-U-15 does not depend on the input order and does not mutate it", () => {
			const input = [30, 10, 40, 20];
			expect(percentile(input, 50)).toBe(20);
			expect(input).toEqual([30, 10, 40, 20]);
		});

		test("TST-U-15 one sample is every percentile", () => {
			for (const p of [0, 50, 95, 99, 100]) expect(percentile([7], p)).toBe(7);
		});

		test("TST-U-15 equal samples give that value", () => {
			expect(percentile([5, 5, 5, 5, 5], 99)).toBe(5);
		});

		test("TST-U-15 an empty sample set is an explicit error", () => {
			expect(() => percentile([], 50)).toThrow(/no samples/);
		});

		test("TST-U-15 a percentile outside 0..100 is rejected", () => {
			expect(() => percentile([1], -1)).toThrow(/percentile/);
			expect(() => percentile([1], 101)).toThrow(/percentile/);
			expect(() => percentile([1], Number.NaN)).toThrow(/percentile/);
		});
	});

	describe("latency recorder", () => {
		test("TST-U-15 summarises count, min, max, mean and p50/p95/p99", () => {
			const recorder = new LatencyRecorder();
			for (let i = 1; i <= 100; i++) recorder.record(i);
			expect(recorder.summarize()).toEqual({
				count: 100,
				min: 1,
				max: 100,
				mean: 50.5,
				p50: 50,
				p95: 95,
				p99: 99,
			});
		});

		test("TST-U-15 summarising nothing is an explicit error", () => {
			expect(() => new LatencyRecorder().summarize()).toThrow(/no samples/);
		});

		test("TST-U-15 rejects negative and non-finite latencies", () => {
			const recorder = new LatencyRecorder();
			expect(() => recorder.record(-1)).toThrow(/latency/);
			expect(() => recorder.record(Number.NaN)).toThrow(/latency/);
			expect(() => recorder.record(Number.POSITIVE_INFINITY)).toThrow(
				/latency/,
			);
		});
	});

	describe("outcomes and error rate", () => {
		test("TST-U-15 sums by HTTP status", () => {
			const tally = new OutcomeTally();
			for (const status of [201, 201, 200, 422, 201]) {
				tally.add({ kind: "http", status });
			}
			expect(tally.total).toBe(5);
			expect(tally.byStatus()).toEqual({ "200": 1, "201": 3, "422": 1 });
		});

		test("TST-U-15 an expected 422 is not a load error", () => {
			const tally = new OutcomeTally();
			tally.add({ kind: "http", status: 201 });
			tally.add({ kind: "http", status: 422 });
			expect(tally.unexpected).toBe(0);
			expect(tally.errorRate).toBe(0);
		});

		test("TST-U-15 5xx, timeout and connection failures are load errors", () => {
			const tally = new OutcomeTally();
			tally.add({ kind: "http", status: 201 });
			tally.add({ kind: "http", status: 503 });
			tally.add({ kind: "http", status: 500 });
			tally.add({ kind: "timeout" });
			tally.add({ kind: "connection" });
			expect(tally.unexpected).toBe(4);
			expect(tally.errorRate).toBe(0.8);
			expect(tally.byStatus()).toEqual({
				"201": 1,
				"500": 1,
				"503": 1,
				timeout: 1,
				connection: 1,
			});
		});

		test("TST-U-15 a 400 or 409 the scenario did not plan for is a load error", () => {
			const tally = new OutcomeTally();
			tally.add({ kind: "http", status: 400 });
			tally.add({ kind: "http", status: 409 });
			expect(tally.unexpected).toBe(2);
		});

		test("TST-U-15 the expected set is configurable", () => {
			const tally = new OutcomeTally([409]);
			tally.add({ kind: "http", status: 409 });
			tally.add({ kind: "http", status: 422 });
			expect(tally.unexpected).toBe(1);
		});

		test("TST-U-15 error rate of no outcomes is 0, not NaN", () => {
			expect(new OutcomeTally().errorRate).toBe(0);
		});

		test("TST-U-15 merges tallies", () => {
			const a = new OutcomeTally();
			const b = new OutcomeTally();
			a.add({ kind: "http", status: 201 });
			b.add({ kind: "http", status: 503 });
			a.merge(b);
			expect(a.total).toBe(2);
			expect(a.unexpected).toBe(1);
		});
	});

	describe("stopwatch and throughput", () => {
		test("TST-U-15 stopwatch reads a monotonic clock", () => {
			let now = 1000;
			const watch = stopwatch(() => now);
			now = 1250.5;
			expect(watch.elapsedMs()).toBe(250.5);
		});

		test("TST-U-15 throughput is operations per second", () => {
			expect(throughput(500, 2000)).toBe(250);
		});

		test("TST-U-15 throughput over a zero or negative duration is an explicit error", () => {
			expect(() => throughput(1, 0)).toThrow(/duration/);
		});
	});
});
