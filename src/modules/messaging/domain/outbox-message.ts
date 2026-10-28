import { InvalidOutboxStateError } from "./errors";
import type { IntegrationEvent } from "./integration-event";

export interface BackoffPolicy {
	baseMs: number;
	capMs: number;
}

/** Outbox publisher backoff: base 1 s, cap 60 s (03-messaging §6.2). */
export const DEFAULT_OUTBOX_BACKOFF: BackoffPolicy = {
	baseMs: 1000,
	capMs: 60_000,
};

export interface OutboxMessageState {
	id: string;
	aggregateId: string;
	groupKey: string;
	eventType: string;
	payload: Readonly<Record<string, unknown>>;
	occurredAt: Date;
	attempts: number;
	nextAttemptAt: Date;
	publishedAt: Date | undefined;
	failedAt: Date | undefined;
	lastError: string | undefined;
}

export class OutboxMessage {
	private constructor(private state: OutboxMessageState) {}

	/** `id` is the eventId, stable across republications. `groupKey` = walletId. */
	static enqueue(
		event: IntegrationEvent<unknown>,
		groupKey: string,
	): OutboxMessage {
		return new OutboxMessage({
			id: event.eventId,
			aggregateId: event.aggregateId,
			groupKey,
			eventType: event.eventType,
			payload: { ...event.toJSON() },
			occurredAt: event.occurredAt,
			attempts: 0,
			nextAttemptAt: event.occurredAt,
			publishedAt: undefined,
			failedAt: undefined,
			lastError: undefined,
		});
	}

	/** Rebuilds persisted state; does not revalidate. */
	static rehydrate(state: OutboxMessageState): OutboxMessage {
		return new OutboxMessage({ ...state });
	}

	get id(): string {
		return this.state.id;
	}
	get aggregateId(): string {
		return this.state.aggregateId;
	}
	get groupKey(): string {
		return this.state.groupKey;
	}
	get eventType(): string {
		return this.state.eventType;
	}
	get payload(): Readonly<Record<string, unknown>> {
		return this.state.payload;
	}
	get occurredAt(): Date {
		return this.state.occurredAt;
	}
	get attempts(): number {
		return this.state.attempts;
	}
	get nextAttemptAt(): Date {
		return this.state.nextAttemptAt;
	}
	get publishedAt(): Date | undefined {
		return this.state.publishedAt;
	}
	get failedAt(): Date | undefined {
		return this.state.failedAt;
	}
	get lastError(): string | undefined {
		return this.state.lastError;
	}

	/** Neither published nor permanently failed. */
	isPending(): boolean {
		return (
			this.state.publishedAt === undefined && this.state.failedAt === undefined
		);
	}

	isDue(now: Date): boolean {
		return (
			this.isPending() && this.state.nextAttemptAt.getTime() <= now.getTime()
		);
	}

	markPublished(at: Date): void {
		this.assertPending("markPublished");
		this.state.publishedAt = at;
	}

	/** Permanent error (`publish_failed`): stops retrying. */
	markFailed(at: Date, error: string): void {
		this.assertPending("markFailed");
		this.state.failedAt = at;
		this.state.lastError = error;
	}

	/**
	 * Transient failure: counts the attempt and schedules the next one with
	 * exponential backoff (base * 2^(attempts-1), capped). There is no attempt
	 * limit: the event is a committed financial fact.
	 */
	scheduleRetry(
		now: Date,
		policy: BackoffPolicy = DEFAULT_OUTBOX_BACKOFF,
	): void {
		this.assertPending("scheduleRetry");
		this.state.attempts += 1;
		// Exponent clamped so very large attempt counts never overflow to Infinity.
		const exponent = Math.min(this.state.attempts - 1, 30);
		const delayMs = Math.min(policy.baseMs * 2 ** exponent, policy.capMs);
		this.state.nextAttemptAt = new Date(now.getTime() + delayMs);
	}

	private assertPending(operation: string): void {
		if (!this.isPending()) {
			throw new InvalidOutboxStateError(
				`cannot ${operation} an outbox message that is already finished`,
			);
		}
	}
}
