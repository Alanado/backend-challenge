import { LatencyRecorder, type Outcome, OutcomeTally } from "./measurement";

export interface TimedRunOptions {
	concurrency: number;
	/** Requests that start inside this window are issued but not measured. */
	warmupMs: number;
	measureMs: number;
	/** One request; the runner times it. Must classify network failures instead of throwing. */
	step(worker: number): Promise<Outcome>;
}

export interface TimedRun {
	latency: LatencyRecorder;
	tally: OutcomeTally;
	issued: number;
	measuredMs: number;
	/** CPU of this (load generator) process over the whole run, % of one core. */
	generatorCpuPercent: number;
}

/** Closed-loop generator: `concurrency` workers, each issuing its next request when the last ends. */
export async function runTimed(options: TimedRunOptions): Promise<TimedRun> {
	const latency = new LatencyRecorder();
	const tally = new OutcomeTally();
	const cpuStart = process.cpuUsage();
	const startedAt = performance.now();
	const warmupEnd = startedAt + options.warmupMs;
	const end = warmupEnd + options.measureMs;
	let issued = 0;
	let lastMeasuredEnd = warmupEnd;

	const worker = async (id: number): Promise<void> => {
		while (performance.now() < end) {
			const begin = performance.now();
			issued++;
			const outcome = await options.step(id);
			const finish = performance.now();
			if (begin >= warmupEnd) {
				latency.record(finish - begin);
				tally.add(outcome);
				lastMeasuredEnd = Math.max(lastMeasuredEnd, finish);
			}
		}
	};
	await Promise.all(
		Array.from({ length: options.concurrency }, (_, id) => worker(id)),
	);

	const wallMs = performance.now() - startedAt;
	const cpu = process.cpuUsage(cpuStart);
	return {
		latency,
		tally,
		issued,
		measuredMs: lastMeasuredEnd - warmupEnd,
		generatorCpuPercent: ((cpu.user + cpu.system) / 1000 / wallMs) * 100,
	};
}
