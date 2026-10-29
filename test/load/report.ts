import type { StrategyResult } from "./lib/strategies";
import type { ScenarioResult } from "./scenarios";

const fmt = (n: number, digits = 1) => n.toFixed(digits);

/** Fixed-width table, one row per scenario. */
export function renderTable(results: readonly ScenarioResult[]): string {
	const header = [
		"scenario",
		"channel",
		"requests",
		"req/s",
		"p50 ms",
		"p95 ms",
		"p99 ms",
		"error %",
		"resets retried",
		"lock conflicts",
		"outbox lag max s",
		"generator cpu %",
	];
	const rows = results.map((r) => [
		`${r.id} ${r.name}`,
		r.channel,
		String(r.measured),
		fmt(r.throughputPerSecond),
		fmt(r.latency.p50),
		fmt(r.latency.p95),
		fmt(r.latency.p99),
		fmt(r.errorRate * 100, 2),
		String(r.recoveredResets),
		String(r.lockConflicts),
		fmt(r.outboxLagMaxSeconds, 2),
		fmt(r.generatorCpuPercent, 0),
	]);
	const widths = header.map((h, i) =>
		Math.max(h.length, ...rows.map((row) => (row[i] as string).length)),
	);
	const line = (cells: string[]) =>
		cells.map((c, i) => c.padEnd(widths[i] as number)).join("  ");
	return [
		line(header),
		line(widths.map((w) => "-".repeat(w))),
		...rows.map(line),
	].join("\n");
}

function table(header: string[], rows: string[][]): string {
	const widths = header.map((h, i) =>
		Math.max(h.length, ...rows.map((row) => (row[i] as string).length)),
	);
	const line = (cells: string[]) =>
		cells.map((c, i) => c.padEnd(widths[i] as number)).join("  ");
	return [
		line(header),
		line(widths.map((w) => "-".repeat(w))),
		...rows.map(line),
	].join("\n");
}

/** A x C: one row per run. */
export function renderStrategyTable(
	results: readonly StrategyResult[],
): string {
	return table(
		[
			"strategy",
			"attempts",
			"attempts/s",
			"p50 ms",
			"p95 ms",
			"p99 ms",
			"accepted",
			"rejected (funds)",
			"lock timeouts",
			"deadlocks",
			"version conflicts",
		],
		results.map((r) => [
			r.strategy === "A" ? "A FOR UPDATE" : "C conditional UPDATE",
			String(r.attempts),
			fmt(r.attemptsPerSecond),
			fmt(r.latency.p50),
			fmt(r.latency.p95),
			fmt(r.latency.p99),
			String(r.accepted),
			String(r.rejected),
			String(r.lockTimeouts),
			String(r.deadlocks),
			String(r.versionConflicts),
		]),
	);
}
