export type TransactionChannel = "http" | "sqs";
export type RetryComponent = "consumer" | "outbox" | "pending_reference";
export type LockConflictType = "lock_timeout" | "deadlock" | "version_assert";
export type IdempotentOutcome = "replay" | "conflict";

/**
 * Value of the `failure_code` label of `wager_transactions_total` when there is no rejection.
 * prom-client wants the same label set on every sample, so "no code" needs a value of its own.
 */
export const NO_FAILURE_CODE = "none";

/**
 * Port for the metrics of 04-api §7. Use cases depend on this, never on prom-client. No method
 * accepts a wallet, player or transaction id: those would be label cardinality bombs.
 */
export abstract class MetricsPort {
	abstract transactionProcessed(labels: {
		status: string;
		kind: string;
		channel: TransactionChannel;
		/** Only on rejections/failures; omitted otherwise. */
		failureCode?: string | undefined;
	}): void;
	abstract idempotentRequest(
		outcome: IdempotentOutcome,
		channel: TransactionChannel,
	): void;
	abstract retry(component: RetryComponent): void;
	abstract dlqMessage(reason: string): void;
	abstract lockConflict(type: LockConflictType): void;
	/** Age in seconds of the oldest publishable outbox event (0 when none). */
	abstract setOutboxLagSeconds(seconds: number): void;
	abstract outboxPublishFailed(): void;
	abstract observeProcessingDuration(
		seconds: number,
		labels: { channel: TransactionChannel; kind: string; outcome: string },
	): void;
	abstract reconciliationDivergence(): void;
	abstract setCircuitBreakerOpen(open: boolean): void;
}

/** For unit tests of use cases that do not care about metrics. */
export class NoopMetrics extends MetricsPort {
	transactionProcessed(): void {}
	idempotentRequest(): void {}
	retry(): void {}
	dlqMessage(): void {}
	lockConflict(): void {}
	setOutboxLagSeconds(): void {}
	outboxPublishFailed(): void {}
	observeProcessingDuration(): void {}
	reconciliationDivergence(): void {}
	setCircuitBreakerOpen(): void {}
}
