import {
	ChangeMessageVisibilityCommand,
	DeleteMessageCommand,
	GetQueueUrlCommand,
	type Message,
	ReceiveMessageCommand,
	type SQSClient,
} from "@aws-sdk/client-sqs";
import type { FaultInjector } from "../../../shared/fault-injector";
import type { AppLogger } from "../../platform/application/log-fields";
import {
	type InboundMessage,
	MessageConsumer,
	type MessageHandler,
	type MessageOutcome,
} from "../application/message-consumer";

/** SQS returns at most 10 messages per ReceiveMessage. */
const RECEIVE_BATCH = 10;
/** Pause after a failed ReceiveMessage (network, missing queue), so a dead broker is not hammered. */
const RECEIVE_ERROR_PAUSE_MS = 1000;

export interface SqsMessageConsumerOptions {
	client: SQSClient;
	/** Either the url or the name is enough; the name is resolved lazily (the queue may not exist yet). */
	queueUrl?: string | undefined;
	queueName: string;
	/** Handlers of different groups running at once (SQS_CONCURRENCY). */
	concurrency: number;
	/** SQS_HANDLER_TIMEOUT_MS, below the queue's visibility timeout. */
	handlerTimeoutMs: number;
	waitTimeSeconds: number;
	faults: FaultInjector;
	logger: AppLogger;
}

interface Delivery {
	message: InboundMessage;
	receiptHandle: string;
}

/**
 * Thin SQS poller (ADR-0015, 03-messaging §3.4). One loop: receive up to 10 messages, group them
 * by `MessageGroupId`, run the groups concurrently (up to `concurrency`) and each group's
 * messages one at a time in the order received, then receive again.
 *
 * The ack (DeleteMessage) is the last step of a message and only follows a handler `ack`, i.e.
 * after the handler's transaction committed. Anything else leaves the message in the queue: a
 * crash, a timeout, a thrown error or a `retry`/`release` outcome all end in a redelivery that
 * the inbox deduplicates.
 */
export class SqsMessageConsumer extends MessageConsumer {
	private handler: MessageHandler | undefined;
	private resolvedUrl: string | undefined;
	private loop: Promise<void> | undefined;
	private stopping = false;
	private abort = new AbortController();

	constructor(private readonly options: SqsMessageConsumerOptions) {
		super();
		this.resolvedUrl = options.queueUrl;
	}

	register(handler: MessageHandler): void {
		this.handler = handler;
	}

	start(): void {
		if (this.loop !== undefined) return;
		if (this.handler === undefined) {
			throw new Error("a MessageHandler must be registered before start()");
		}
		this.stopping = false;
		this.abort = new AbortController();
		this.loop = this.run();
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.abort.abort();
		await this.loop;
		this.loop = undefined;
	}

	private async run(): Promise<void> {
		while (!this.stopping) {
			let deliveries: Delivery[];
			try {
				deliveries = await this.receive();
			} catch (error) {
				if (this.stopping) return;
				this.options.logger.error("receiving messages failed", {}, error);
				await this.pause(RECEIVE_ERROR_PAUSE_MS);
				continue;
			}
			if (deliveries.length > 0) await this.processBatch(deliveries);
		}
	}

	private async receive(): Promise<Delivery[]> {
		const queueUrl = await this.queueUrl();
		const response = await this.options.client.send(
			new ReceiveMessageCommand({
				QueueUrl: queueUrl,
				MaxNumberOfMessages: RECEIVE_BATCH,
				WaitTimeSeconds: this.options.waitTimeSeconds,
				MessageSystemAttributeNames: [
					"ApproximateReceiveCount",
					"MessageGroupId",
					"MessageDeduplicationId",
				],
			}),
			{ abortSignal: this.abort.signal },
		);
		return (response.Messages ?? []).flatMap((raw) => {
			const delivery = toDelivery(raw);
			if (delivery === undefined) {
				this.options.logger.error("received a malformed queue message");
			}
			return delivery === undefined ? [] : [delivery];
		});
	}

	/** Groups run concurrently up to the cap; a group's own messages never do. */
	private async processBatch(deliveries: Delivery[]): Promise<void> {
		const groups = new Map<string, Delivery[]>();
		for (const delivery of deliveries) {
			const group = groups.get(delivery.message.groupId);
			if (group === undefined) groups.set(delivery.message.groupId, [delivery]);
			else group.push(delivery);
		}
		const queue = [...groups.values()];
		const worker = async (): Promise<void> => {
			for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
				try {
					await this.processGroup(next);
				} catch (error) {
					// A failure after the handler (the crash hook) abandons the rest of the group,
					// as a dead process would: nothing is deleted or released, visibility expires.
					this.options.logger.error("group processing aborted", {}, error);
				}
			}
		};
		const width = Math.min(this.options.concurrency, queue.length);
		await Promise.all(Array.from({ length: width }, worker));
	}

	private async processGroup(group: Delivery[]): Promise<void> {
		for (const [index, delivery] of group.entries()) {
			if (this.stopping) {
				await this.giveBack(group.slice(index));
				return;
			}
			const outcome = await this.invoke(delivery.message);
			const rest = group.slice(index + 1);
			switch (outcome.kind) {
				case "ack":
					this.options.faults.check("crash-after-commit-before-ack");
					await this.acknowledge(delivery);
					break;
				case "retry":
					await this.setVisibility(delivery, outcome.delaySeconds);
					await this.giveBack(rest);
					return;
				case "release":
					await this.setVisibility(delivery, 0);
					await this.giveBack(rest);
					return;
			}
		}
	}

	/** Runs the handler under the timeout; whatever goes wrong becomes `release` (not deleted, back at once). */
	private async invoke(message: InboundMessage): Promise<MessageOutcome> {
		const { handler } = this;
		if (handler === undefined) return { kind: "release" };
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<"timeout">((resolve) => {
			timer = setTimeout(
				() => resolve("timeout"),
				this.options.handlerTimeoutMs,
			);
		});
		try {
			const result = await Promise.race([handler(message), timedOut]);
			if (result === "timeout") {
				this.options.logger.warn("handler timed out", {
					messageId: message.id,
				});
				return { kind: "release" };
			}
			return result;
		} catch (error) {
			this.options.logger.error(
				"handler failed",
				{ messageId: message.id },
				error,
			);
			return { kind: "release" };
		} finally {
			clearTimeout(timer);
		}
	}

	/** The one place a message is deleted: after the handler said `ack`. */
	private async acknowledge(delivery: Delivery): Promise<void> {
		try {
			await this.options.client.send(
				new DeleteMessageCommand({
					QueueUrl: await this.queueUrl(),
					ReceiptHandle: delivery.receiptHandle,
				}),
			);
		} catch (error) {
			// The effect is committed; the message returns and the inbox discards it.
			this.options.logger.error(
				"acknowledging a message failed",
				{ messageId: delivery.message.id },
				error,
			);
		}
	}

	private async giveBack(deliveries: Delivery[]): Promise<void> {
		await Promise.all(deliveries.map((d) => this.setVisibility(d, 0)));
	}

	private async setVisibility(
		delivery: Delivery,
		seconds: number,
	): Promise<void> {
		try {
			await this.options.client.send(
				new ChangeMessageVisibilityCommand({
					QueueUrl: await this.queueUrl(),
					ReceiptHandle: delivery.receiptHandle,
					VisibilityTimeout: seconds,
				}),
			);
		} catch {
			// Worst case the visibility timeout expires by itself.
			this.options.logger.warn("changing message visibility failed", {
				messageId: delivery.message.id,
			});
		}
	}

	/** A failed lookup is never cached: the queue may be created later. */
	private async queueUrl(): Promise<string> {
		if (this.resolvedUrl !== undefined) return this.resolvedUrl;
		const found = await this.options.client.send(
			new GetQueueUrlCommand({ QueueName: this.options.queueName }),
			{ abortSignal: this.abort.signal },
		);
		if (found.QueueUrl === undefined) throw new Error("QueueUrlMissing");
		this.resolvedUrl = found.QueueUrl;
		return found.QueueUrl;
	}

	/** Sleeps `ms`, cut short by `stop()`. */
	private pause(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				this.abort.signal.removeEventListener("abort", done);
				resolve();
			};
			const timer = setTimeout(done, ms);
			this.abort.signal.addEventListener("abort", done);
		});
	}
}

function toDelivery(raw: Message): Delivery | undefined {
	const { MessageId, Body, ReceiptHandle, Attributes } = raw;
	if (!MessageId || Body === undefined || !ReceiptHandle) return undefined;
	return {
		receiptHandle: ReceiptHandle,
		message: {
			id: MessageId,
			body: Body,
			receiveCount: Number(Attributes?.ApproximateReceiveCount ?? 1),
			groupId: Attributes?.MessageGroupId ?? MessageId,
			deduplicationId: Attributes?.MessageDeduplicationId ?? MessageId,
		},
	};
}
