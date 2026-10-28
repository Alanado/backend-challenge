import type { OutboxMessage } from "../domain/outbox-message";

export abstract class OutboxRepository {
	/** Joins the caller's transaction: the event is only visible once the business change commits. */
	abstract enqueue(message: OutboxMessage): Promise<void>;
	abstract findById(id: string): Promise<OutboxMessage | undefined>;
	/**
	 * Publisher claim: due, unpublished, not failed rows, oldest first, `FOR UPDATE SKIP LOCKED`.
	 * Rows locked by another transaction are skipped, never waited for. Requires a transaction.
	 */
	abstract lockPublishable(limit: number, now: Date): Promise<OutboxMessage[]>;
	/** Writes the publisher-owned columns (attempts, schedule, published/failed marks). */
	abstract update(message: OutboxMessage): Promise<void>;
	/** `occurred_at` of the oldest event still waiting to be published (due or backing off). */
	abstract oldestPendingOccurredAt(): Promise<Date | undefined>;
}
