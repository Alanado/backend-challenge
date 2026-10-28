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
import type { MetricsPort } from "../../platform/application/metrics";
import type { ReceiveGate } from "../application/circuit-breaker";
import {
	type DeadLetterQueue,
	type InboundMessage,
	MessageConsumer,
	type MessageHandler,
	type MessageOutcome,
} from "../application/message-consumer";

/** SQS returns at most 10 messages per ReceiveMessage. */
const RECEIVE_BATCH = 10;
/** Pause after a failed ReceiveMessage (network, missing queue), so a dead broker is not hammered. */
const RECEIVE_ERROR_PAUSE_MS = 1000;
/** How often a closed gate is asked again whether fetching may resume. */
const GATE_POLL_MS = 50;

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
	metrics: MetricsPort;
	deadLetter: DeadLetterQueue;
	/** The circuit breaker: while it does not allow requests nothing is fetched or handled. */
	gate?: ReceiveGate;
	/**
	 * SHUTDOWN_GRACE_MS: how long `stop()` waits for the handlers in flight. When it runs out, their
	 * messages are returned (visibility 0) and NOT deleted. Without it `stop()` waits as long as it takes.
	 */
	shutdownGraceMs?: number;
}

interface Delivery {
	message: InboundMessage;
	receiptHandle: string;
	/** `stop()` gave this message back: whatever its handler answers later is ignored. */
	abandoned?: boolean;
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
	/** Received and not yet deleted, released or returned: what `stop()` gives back after the grace period. */
	private readonly open = new Set<Delivery>();

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
		const { loop } = this;
		const grace = this.options.shutdownGraceMs;
		if (loop !== undefined) {
			if (grace === undefined || (await settlesWithin(loop, grace))) {
				await loop;
			} else {
				await this.returnOpenDeliveries();
			}
		}
		this.loop = undefined;
	}

	/**
	 * The grace period is over and handlers are still running: hand their messages (and the ones
	 * of the batch that never got a slot) back at once, and never delete them. If a handler had
	 * already committed, the redelivery is dropped by the inbox.
	 */
	private async returnOpenDeliveries(): Promise<void> {
		const pending = [...this.open];
		this.options.logger.warn(
			"shutdown grace period ended with handlers still running; returning their messages",
			{ reason: "shutdown_grace_expired" },
		);
		for (const delivery of pending) delivery.abandoned = true;
		await Promise.all(pending.map((d) => this.setVisibility(d, 0)));
	}

	private async run(): Promise<void> {
		while (!this.stopping) {
			// An open breaker stops the fetching: a message not received loses no attempt.
			if (this.options.gate && !(await this.options.gate.allowRequests())) {
				await this.pause(GATE_POLL_MS);
				continue;
			}
			let deliveries: Delivery[];
			try {
				deliveries = await this.receive();
			} catch (error) {
				if (this.stopping) return;
				this.options.logger.error("receiving messages failed", {}, error);
				await this.pause(RECEIVE_ERROR_PAUSE_MS);
				continue;
			}
			if (deliveries.length > 0) {
				for (const delivery of deliveries) this.open.add(delivery);
				await this.processBatch(deliveries);
			}
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
			if (delivery.abandoned) return;
			// Stopping, or the breaker opened since the batch was fetched: hand the rest back untouched.
			if (this.stopping || this.options.gate?.isOpen()) {
				await this.giveBack(group.slice(index));
				return;
			}
			const outcome = await this.invoke(delivery.message);
			// Returned by `stop()` while it ran: its late answer (even an ack) changes nothing.
			if (delivery.abandoned) return;
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
				case "dead-letter":
					// The DLQ copy comes first, the delete after it. If the copy fails the original
					// stays (and blocks its group until it returns): losing it would be worse.
					if (!(await this.sendToDeadLetter(delivery, outcome))) {
						await this.setVisibility(delivery, 0);
						await this.giveBack(rest);
						return;
					}
					await this.acknowledge(delivery);
					break;
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

	private async sendToDeadLetter(
		delivery: Delivery,
		failure: { errorCode: string; reason: string },
	): Promise<boolean> {
		try {
			await this.options.deadLetter.send(delivery.message, failure);
		} catch (error) {
			this.options.logger.error(
				"sending a message to the DLQ failed",
				{ messageId: delivery.message.id, errorCode: failure.errorCode },
				error,
			);
			return false;
		}
		this.options.metrics.dlqMessage(failure.reason);
		this.options.logger.warn("message sent to the DLQ", {
			messageId: delivery.message.id,
			errorCode: failure.errorCode,
			reason: failure.reason,
		});
		return true;
	}

	/** Deletes the message: after the handler said `ack`, or after its copy reached the DLQ. */
	private async acknowledge(delivery: Delivery): Promise<void> {
		this.open.delete(delivery);
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
		this.open.delete(delivery);
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

/** `true` when `work` settled within `ms`; `false` when the time ran out first. */
async function settlesWithin(
	work: Promise<void>,
	ms: number,
): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), ms);
	});
	try {
		return await Promise.race([work.then(() => true as const), expired]);
	} finally {
		clearTimeout(timer);
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
