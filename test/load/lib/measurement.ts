/**
 * Measurement primitives of the load test (ADR-0021). Pure: no I/O, no money. Percentiles use the
 * nearest-rank method, so every reported value is a latency that was actually observed.
 */

export function percentile(samples: readonly number[], p: number): number {
	if (!Number.isFinite(p) || p < 0 || p > 100) {
		throw new Error(`percentile must be within 0..100, got ${p}`);
	}
	if (samples.length === 0) throw new Error("percentile of no samples");
	const sorted = [...samples].sort((a, b) => a - b);
	const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
	return sorted[rank - 1] as number;
}

export interface LatencySummary {
	count: number;
	min: number;
	max: number;
	mean: number;
	p50: number;
	p95: number;
	p99: number;
}

export class LatencyRecorder {
	private readonly samples: number[] = [];

	get count(): number {
		return this.samples.length;
	}

	record(ms: number): void {
		if (!Number.isFinite(ms) || ms < 0) {
			throw new Error(
				`latency must be a finite, non-negative number, got ${ms}`,
			);
		}
		this.samples.push(ms);
	}

	merge(other: LatencyRecorder): void {
		for (const ms of other.samples) this.samples.push(ms);
	}

	summarize(): LatencySummary {
		if (this.samples.length === 0) throw new Error("summary of no samples");
		let sum = 0;
		let min = Number.POSITIVE_INFINITY;
		let max = Number.NEGATIVE_INFINITY;
		for (const ms of this.samples) {
			sum += ms;
			min = Math.min(min, ms);
			max = Math.max(max, ms);
		}
		return {
			count: this.samples.length,
			min,
			max,
			mean: sum / this.samples.length,
			p50: percentile(this.samples, 50),
			p95: percentile(this.samples, 95),
			p99: percentile(this.samples, 99),
		};
	}
}

export type Outcome =
	| { kind: "http"; status: number }
	| { kind: "timeout" }
	| { kind: "connection" };

/**
 * Outcome counts and error rate. Every 2xx is expected, plus the business statuses a scenario
 * plans for (default: 422, such as `INSUFFICIENT_FUNDS`). Everything else (5xx, timeout, connection,
 * and a 4xx nobody planned, which means the generator is wrong) is a load error.
 */
export class OutcomeTally {
	private readonly counts = new Map<string, number>();
	private readonly expectedStatuses: ReadonlySet<number>;
	private expectedCount = 0;
	private unexpectedCount = 0;

	constructor(expectedStatuses: readonly number[] = [422]) {
		this.expectedStatuses = new Set(expectedStatuses);
	}

	get total(): number {
		return this.expectedCount + this.unexpectedCount;
	}

	get unexpected(): number {
		return this.unexpectedCount;
	}

	get errorRate(): number {
		return this.total === 0 ? 0 : this.unexpectedCount / this.total;
	}

	add(outcome: Outcome): void {
		const label =
			outcome.kind === "http" ? String(outcome.status) : outcome.kind;
		this.counts.set(label, (this.counts.get(label) ?? 0) + 1);
		const expected =
			outcome.kind === "http" &&
			((outcome.status >= 200 && outcome.status < 300) ||
				this.expectedStatuses.has(outcome.status));
		if (expected) this.expectedCount++;
		else this.unexpectedCount++;
	}

	merge(other: OutcomeTally): void {
		for (const [label, n] of other.counts) {
			this.counts.set(label, (this.counts.get(label) ?? 0) + n);
		}
		this.expectedCount += other.expectedCount;
		this.unexpectedCount += other.unexpectedCount;
	}

	byStatus(): Record<string, number> {
		return Object.fromEntries(this.counts);
	}
}

export function stopwatch(now: () => number = () => performance.now()): {
	elapsedMs(): number;
} {
	const startedAt = now();
	return { elapsedMs: () => now() - startedAt };
}

export function throughput(operations: number, durationMs: number): number {
	if (!(durationMs > 0)) {
		throw new Error(`duration must be positive, got ${durationMs}`);
	}
	return operations / (durationMs / 1000);
}
