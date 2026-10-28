import type { OutboxMessage } from "../domain/outbox-message";

export abstract class OutboxRepository {
	/** Joins the caller's transaction: the event is only visible once the business change commits. */
	abstract enqueue(message: OutboxMessage): Promise<void>;
	abstract findById(id: string): Promise<OutboxMessage | undefined>;
}
