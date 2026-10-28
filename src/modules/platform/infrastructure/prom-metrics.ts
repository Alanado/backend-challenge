import { Injectable } from "@nestjs/common";
import { Counter, Gauge, Histogram, Registry } from "prom-client";
import {
	type IdempotentOutcome,
	type LockConflictType,
	MetricsPort,
	NO_FAILURE_CODE,
	type RetryComponent,
	type TransactionChannel,
} from "../application/metrics";

/** Seconds, from 1 ms up to 10 s (ADR-0018: latency with millisecond resolution). */
export const DURATION_BUCKETS_SECONDS = [
	0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/**
 * prom-client adapter. Every metric of 04-api §7 is registered up front, on a registry of its own
 * (not the global one, so several instances in one process — tests — do not collide). The Node
 * default metrics are left out: under Bun only the process/heap group is reliable (adr/0002-spike).
 */
@Injectable()
export class PromMetrics extends MetricsPort {
	private readonly registry = new Registry();

	private readonly transactions = new Counter({
		name: "wager_transactions_total",
		help: "Wagering transactions that reached a result",
		labelNames: ["status", "kind", "channel", "failure_code"],
		registers: [this.registry],
	});
	private readonly idempotent = new Counter({
		name: "idempotent_requests_total",
		help: "Requests answered by idempotency (replay or key conflict)",
		labelNames: ["outcome", "channel"],
		registers: [this.registry],
	});
	private readonly retries = new Counter({
		name: "retries_total",
		help: "Retries by component",
		labelNames: ["component"],
		registers: [this.registry],
	});
	private readonly dlq = new Counter({
		name: "dlq_messages_total",
		help: "Messages sent to the dead-letter queue",
		labelNames: ["reason"],
		registers: [this.registry],
	});
	private readonly lockConflicts = new Counter({
		name: "lock_conflicts_total",
		help: "Lock timeouts, deadlocks and version assertion failures",
		labelNames: ["type"],
		registers: [this.registry],
	});
	private readonly outboxLag = new Gauge({
		name: "outbox_lag_seconds",
		help: "Age of the oldest publishable outbox event",
		registers: [this.registry],
	});
	private readonly outboxFailed = new Counter({
		name: "outbox_publish_failed_total",
		help: "Outbox events that failed permanently",
		registers: [this.registry],
	});
	private readonly duration = new Histogram({
		name: "processing_duration_seconds",
		help: "Time to process a transaction, in seconds",
		labelNames: ["channel", "kind", "outcome"],
		buckets: DURATION_BUCKETS_SECONDS,
		registers: [this.registry],
	});
	private readonly divergences = new Counter({
		name: "reconciliation_divergences_total",
		help: "Reconciliations that found a divergence",
		registers: [this.registry],
	});
	private readonly breaker = new Gauge({
		name: "circuit_breaker_open",
		help: "1 while the infrastructure circuit breaker is open",
		registers: [this.registry],
	});

	transactionProcessed(labels: {
		status: string;
		kind: string;
		channel: TransactionChannel;
		failureCode?: string | undefined;
	}): void {
		this.transactions.inc({
			status: labels.status,
			kind: labels.kind,
			channel: labels.channel,
			failure_code: labels.failureCode ?? NO_FAILURE_CODE,
		});
	}

	idempotentRequest(
		outcome: IdempotentOutcome,
		channel: TransactionChannel,
	): void {
		this.idempotent.inc({ outcome, channel });
	}

	retry(component: RetryComponent): void {
		this.retries.inc({ component });
	}

	dlqMessage(reason: string): void {
		this.dlq.inc({ reason });
	}

	lockConflict(type: LockConflictType): void {
		this.lockConflicts.inc({ type });
	}

	setOutboxLagSeconds(seconds: number): void {
		this.outboxLag.set(seconds);
	}

	outboxPublishFailed(): void {
		this.outboxFailed.inc();
	}

	observeProcessingDuration(
		seconds: number,
		labels: { channel: TransactionChannel; kind: string; outcome: string },
	): void {
		this.duration.observe(
			{ channel: labels.channel, kind: labels.kind, outcome: labels.outcome },
			seconds,
		);
	}

	reconciliationDivergence(): void {
		this.divergences.inc();
	}

	setCircuitBreakerOpen(open: boolean): void {
		this.breaker.set(open ? 1 : 0);
	}

	render(): Promise<string> {
		return this.registry.metrics();
	}

	get contentType(): string {
		return this.registry.contentType;
	}
}
