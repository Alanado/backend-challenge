import { readFileSync } from "node:fs";
import { cpus, release, totalmem } from "node:os";
import type { Instance } from "../../support/spawnApp";

const TRANSACTION_STATUSES = [
	"PROCESSED",
	"REJECTED",
	"PENDING_REFERENCE",
	"FAILED",
] as const;

export interface MetricSnapshot {
	lockConflicts: number;
	idempotentRequests: number;
	transactions: Record<string, number>;
}

async function sum(
	instances: readonly Instance[],
	name: string,
	labels?: Record<string, string>,
): Promise<number> {
	const values = await Promise.all(
		instances.map((i) => i.metric(name, labels)),
	);
	return values.reduce((a, b) => a + b, 0);
}

/** Counters summed over every instance (each one keeps its own registry). */
export async function snapshot(
	instances: readonly Instance[],
): Promise<MetricSnapshot> {
	const transactions: Record<string, number> = {};
	for (const status of TRANSACTION_STATUSES) {
		transactions[status] = await sum(instances, "wager_transactions_total", {
			status,
		});
	}
	return {
		lockConflicts: await sum(instances, "lock_conflicts_total"),
		idempotentRequests: await sum(instances, "idempotent_requests_total"),
		transactions,
	};
}

export function delta(
	after: MetricSnapshot,
	before: MetricSnapshot,
): MetricSnapshot {
	return {
		lockConflicts: after.lockConflicts - before.lockConflicts,
		idempotentRequests: after.idempotentRequests - before.idempotentRequests,
		transactions: Object.fromEntries(
			Object.entries(after.transactions).map(([k, v]) => [
				k,
				v - (before.transactions[k] ?? 0),
			]),
		),
	};
}

/** Highest `outbox_lag_seconds` seen on any instance, sampled every `intervalMs`. */
export class LagSampler {
	private max = 0;
	private running = false;
	private loop: Promise<void> | undefined;

	constructor(
		private readonly instances: readonly Instance[],
		private readonly intervalMs = 1000,
	) {}

	start(): void {
		this.running = true;
		this.loop = (async () => {
			while (this.running) {
				await this.sample();
				await new Promise((resolve) => setTimeout(resolve, this.intervalMs));
			}
		})();
	}

	async sample(): Promise<number> {
		const lags = await Promise.all(
			this.instances.map((i) => i.metric("outbox_lag_seconds")),
		);
		const current = Math.max(...lags);
		this.max = Math.max(this.max, current);
		return current;
	}

	async stop(): Promise<number> {
		this.running = false;
		await this.loop;
		await this.sample();
		return this.max;
	}
}

/** Resident memory in MB of a process (Linux `/proc`); `undefined` when it cannot be read. */
export function rssMb(pid: number): number | undefined {
	try {
		const status = readFileSync(`/proc/${pid}/status`, "utf8");
		const match = /VmRSS:\s+(\d+) kB/.exec(status);
		return match === null ? undefined : Number(match[1]) / 1024;
	} catch {
		return undefined;
	}
}

export function environment(): Record<string, string | number> {
	const model = cpus()[0]?.model ?? "unknown";
	return {
		cpuModel: model,
		cpuCores: cpus().length,
		ramTotalMb: Math.round(totalmem() / 1024 / 1024),
		kernel: release(),
		bun: Bun.version,
	};
}
