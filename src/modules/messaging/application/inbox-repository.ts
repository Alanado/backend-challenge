import type { InboxMessage } from "../domain/inbox-message";

export abstract class InboxRepository {
	/** `INSERT … ON CONFLICT DO NOTHING`: `false` when the (consumer, messageId) pair already exists. */
	abstract tryReceive(message: InboxMessage): Promise<boolean>;
	abstract find(
		consumerName: string,
		messageId: string,
	): Promise<InboxMessage | undefined>;
	/** Persists `processedAt` of an already-received message. */
	abstract markProcessed(message: InboxMessage): Promise<void>;
}
