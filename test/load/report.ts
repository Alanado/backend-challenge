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
