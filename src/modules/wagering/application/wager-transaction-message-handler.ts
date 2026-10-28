import type {
	InboundMessage,
	MessageHandler,
	MessageOutcome,
} from "../../messaging/application/message-consumer";
import { LogContext } from "../../platform/application/log-context";
import type { AppLogger } from "../../platform/application/log-fields";
import type { MetricsPort } from "../../platform/application/metrics";
import {
	classifyMessageError,
	visibilityBackoffSeconds,
} from "./classify-message-error";
import type {
	SubmitWagerTransaction,
	WagerTransactionResult,
} from "./submit-wager-transaction";
import { parseWagerTransactionMessage } from "./wager-transaction-message";

/** What became of one delivery, before the consumer turns it into queue operations. */
export type MessageProcessing =
	| { kind: "ack"; result: WagerTransactionResult }
	| { kind: "retry"; delaySeconds: number; reason: string }
	| { kind: "release"; reason: string }
	| { kind: "permanent"; errorCode: string; reason: string };

export interface WagerTransactionMessageHandlerDeps {
	submit: SubmitWagerTransaction;
	metrics: MetricsPort;
	logger: AppLogger;
	backoff: { baseS: number; capS: number };
}

/**
 * The SQS side of the wagering use case (RF-MSG-01): parse, run the SAME `SubmitWagerTransaction`
 * as HTTP on the `sqs` channel, and classify whatever it threw. It never touches the queue: the
 * consumer deletes only on `ack`, after the use case's transaction committed.
 */
export class WagerTransactionMessageHandler {
	constructor(private readonly deps: WagerTransactionMessageHandlerDeps) {}

	/** Registered with the `MessageConsumer`. */
	readonly handle: MessageHandler = async (message) =>
		this.toOutcome(await this.process(message));

	async process(message: InboundMessage): Promise<MessageProcessing> {
		// The business messageId is the correlation id once the body is read; until then, the broker's.
		return LogContext.run(
			{ correlationId: message.id, messageId: message.id },
			async () => {
				try {
					const parsed = parseWagerTransactionMessage(message.body);
					LogContext.set({
						correlationId: parsed.messageId,
						messageId: parsed.messageId,
					});
					const result = await this.deps.submit.execute(parsed.command, {
						channel: "sqs",
						correlationId: parsed.messageId,
						messageId: parsed.messageId,
						messageHash: parsed.bodyHash,
					});
					return { kind: "ack", result };
				} catch (error) {
					return this.fail(error, message);
				}
			},
		);
	}

	private fail(error: unknown, message: InboundMessage): MessageProcessing {
		const classified = classifyMessageError(error);
		const { logger, metrics } = this.deps;
		switch (classified.kind) {
			case "transient": {
				metrics.retry("consumer");
				const delaySeconds = visibilityBackoffSeconds(
					message.receiveCount,
					this.deps.backoff.baseS,
					this.deps.backoff.capS,
				);
				logger.warn("message failed, will be retried", {
					reason: classified.reason,
				});
				return { kind: "retry", delaySeconds, reason: classified.reason };
			}
			case "infrastructure":
				logger.error("infrastructure unavailable", {}, error);
				return { kind: "release", reason: classified.reason };
			case "permanent":
				logger.warn("message can never succeed", {
					errorCode: classified.errorCode,
					reason: classified.reason,
				});
				return classified;
		}
	}

	/**
	 * T-042b sends `permanent` to the DLQ. Until then it is only handed back, so nothing is lost
	 * and nothing is acknowledged.
	 */
	private toOutcome(processing: MessageProcessing): MessageOutcome {
		switch (processing.kind) {
			case "ack":
				return { kind: "ack" };
			case "retry":
				return { kind: "retry", delaySeconds: processing.delaySeconds };
			case "release":
			case "permanent":
				return { kind: "release" };
		}
	}
}
