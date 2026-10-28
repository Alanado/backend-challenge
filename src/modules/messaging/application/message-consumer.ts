/** One delivery of a queue message, as the handler sees it (the receipt handle stays in the adapter). */
export interface InboundMessage {
	/** The broker's id of the message. The business `messageId` lives inside `body`. */
	id: string;
	body: string;
	/** `ApproximateReceiveCount`: 1 on the first delivery. */
	receiveCount: number;
	/** `MessageGroupId`; messages of one group are handled one at a time, in order. */
	groupId: string;
	/** `MessageDeduplicationId`, kept so a dead-lettered copy can reuse it (FIFO DLQ). */
	deduplicationId: string;
}

/**
 * What the handler decided about a delivery (03-messaging §3.2). The consumer applies it:
 *  - `ack`: the effect is committed; delete the message.
 *  - `retry`: a transient failure of this message; keep it, invisible for `delaySeconds`.
 *  - `release`: nothing was decided (infrastructure down, timeout); visible again at once.
 * A `retry` or `release` also hands back the rest of the group's messages in the same batch.
 */
export type MessageOutcome =
	| { kind: "ack" }
	| { kind: "retry"; delaySeconds: number }
	| { kind: "release" };

export type MessageHandler = (
	message: InboundMessage,
) => Promise<MessageOutcome>;

/**
 * Port of the queue consumer (ADR-0015): the adapter decides how to fetch and in which order to
 * run handlers; the handler decides what each message means. The delete (ack) is the adapter's,
 * and happens only after the handler returned `ack`.
 */
export abstract class MessageConsumer {
	abstract register(handler: MessageHandler): void;
	abstract start(): void;
	/** Stops fetching and resolves once the handlers in flight have finished. */
	abstract stop(): Promise<void>;
}
