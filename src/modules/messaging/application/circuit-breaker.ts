import type { Clock } from "../../../shared/clock";
import type { MetricsPort } from "../../platform/application/metrics";

/** What the poller needs from the breaker: may it fetch, and is the circuit open right now. */
export interface ReceiveGate {
	/**
	 * `true` when fetching is allowed. While open it answers `false` until the cooldown ends, then
	 * runs one probe (half-open): a passing probe closes the circuit and answers `true`.
	 */
	allowRequests(): Promise<boolean>;
	isOpen(): boolean;
}

export interface CircuitBreakerOptions {
	clock: Clock;
	cooldownMinMs: number;
	cooldownMaxMs: number;
	/** `SELECT 1`: resolves when the database answers, rejects otherwise. */
	probe: () => Promise<void>;
	metrics: MetricsPort;
	/** A probe that has not answered by then counts as failed (default 2 s). */
	probeTimeoutMs?: number;
}

type State = "closed" | "open" | "half-open";

/**
 * Circuit breaker of the infrastructure (ADR-0015, 03-messaging §5).
 *
 *   closed ──reportFailure──▶ open ──cooldown elapsed, allowRequests──▶ half-open
 *      ▲                        ▲                                          │
 *      └────── probe passes ────┼──────────────────────────────────────────┤
 *                               └────── probe fails (cooldown doubles) ────┘
 *
 * Only infrastructure failures (database or network unreachable) feed it; `lock_timeout` and
 * deadlock are the message's problem and never come here. While it is not closed the consumer
 * does not fetch, so an unreceived message loses no delivery attempt.
 */
export class CircuitBreaker implements ReceiveGate {
	private state: State = "closed";
	/** Consecutive openings since the last close: drives the exponential cooldown. */
	private openings = 0;
	private reopenAtMs = 0;

	constructor(private readonly options: CircuitBreakerOptions) {}

	/** True while open or half-open: the gauge `circuit_breaker_open` and the readiness. */
	isOpen(): boolean {
		return this.state !== "closed";
	}

	/** A handler saw the infrastructure fail. Ignored when already open: one outage, one opening. */
	reportFailure(): void {
		if (this.state !== "closed") return;
		this.openings = 0;
		this.open();
		this.options.metrics.setCircuitBreakerOpen(true);
	}

	async allowRequests(): Promise<boolean> {
		if (this.state === "closed") return true;
		// Half-open: the probe of another caller is running.
		if (this.state === "half-open") return false;
		if (this.options.clock.now().getTime() < this.reopenAtMs) return false;

		this.state = "half-open";
		if (await this.probePasses()) {
			this.state = "closed";
			this.openings = 0;
			this.options.metrics.setCircuitBreakerOpen(false);
			return true;
		}
		this.open();
		return false;
	}

	private open(): void {
		this.openings += 1;
		const { cooldownMinMs, cooldownMaxMs } = this.options;
		const cooldown = Math.min(
			cooldownMaxMs,
			cooldownMinMs * 2 ** Math.min(this.openings - 1, 30),
		);
		this.reopenAtMs = this.options.clock.now().getTime() + cooldown;
		this.state = "open";
	}

	private async probePasses(): Promise<boolean> {
		const { probe, probeTimeoutMs = 2000 } = this.options;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error("probe timed out")),
				probeTimeoutMs,
			);
		});
		try {
			await Promise.race([probe(), timeout]);
			return true;
		} catch {
			return false;
		} finally {
			clearTimeout(timer);
		}
	}
}
