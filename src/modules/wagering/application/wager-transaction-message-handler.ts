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
import type { RecordExhaustedTransaction } from "./record-exhausted-transaction";
import type {
	SubmitWagerTransaction,
	WagerTransactionResult,
} from "./submit-wager-transaction";
import {
	parseWagerTransactionMessage,
	type WagerTransactionMessage,
} from "./wager-transaction-message";

/** `errorCode` and `reason` of a message dead-lettered for running out of attempts. */
export const ATTEMPTS_EXHAUSTED = {
	errorCode: "PROCESSING_ATTEMPTS_EXHAUSTED",
	reason: "attempts_exhausted",
} as const;

/** What became of one delivery, before the consumer turns it into queue operations. */
export type MessageProcessing =
	| { kind: "ack"; result?: WagerTransactionResult | undefined }
	| { kind: "retry"; delaySeconds: number; reason: string }
	| { kind: "release"; reason: string }
	| { kind: "permanent"; errorCode: string; reason: string };

export interface WagerTransactionMessageHandlerDeps {
	submit: SubmitWagerTransaction;
	exhausted: RecordExhaustedTransaction;
	metrics: MetricsPort;
	logger: AppLogger;
	backoff: { baseS: number; capS: number };
	/** SQS_MAX_RECEIVE: the delivery that reaches it is the last one. */
	maxReceive: number;
	/** The circuit breaker: told whenever the infrastructure (not the message) failed. */
	infrastructure?: { reportFailure(): void };
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
				let parsed: WagerTransactionMessage | undefined;
				try {
					parsed = parseWagerTransactionMessage(message.body);
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
					return this.fail(error, message, parsed);
				}
			},
		);
	}

	private async fail(
		error: unknown,
		message: InboundMessage,
		parsed: WagerTransactionMessage | undefined,
	): Promise<MessageProcessing> {
		const classified = classifyMessageError(error);
		const { logger, metrics } = this.deps;
		switch (classified.kind) {
			case "transient": {
				if (
					parsed !== undefined &&
					message.receiveCount >= this.deps.maxReceive
				) {
					return this.exhaust(parsed, classified.reason);
				}
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
				this.deps.infrastructure?.reportFailure();
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
	 * Last delivery and still failing: record FAILED if the database answers and the wallet can be
	 * locked, then dead-letter. A transaction that already has a result (an earlier attempt
	 * succeeded and only its ack was lost) is just acked.
	 */
	private async exhaust(
		parsed: WagerTransactionMessage,
		lastReason: string,
	): Promise<MessageProcessing> {
		const { logger } = this.deps;
		try {
			const recorded = await this.deps.exhausted.execute(parsed.command, {
				messageId: parsed.messageId,
				messageHash: parsed.bodyHash,
			});
			if (recorded === "already-handled") {
				logger.info("message was already handled, nothing to give up on");
				return { kind: "ack" };
			}
		} catch (error) {
			// No FAILED and no event without a database that answers: the DLQ is then the record.
			logger.error("could not record the exhausted transaction", {}, error);
		}
		logger.warn("attempts exhausted", { reason: lastReason });
		return { kind: "permanent", ...ATTEMPTS_EXHAUSTED };
	}

	private toOutcome(processing: MessageProcessing): MessageOutcome {
		switch (processing.kind) {
			case "ack":
				return { kind: "ack" };
			case "retry":
				return { kind: "retry", delaySeconds: processing.delaySeconds };
			case "release":
				return { kind: "release" };
			case "permanent":
				return {
					kind: "dead-letter",
					errorCode: processing.errorCode,
					reason: processing.reason,
				};
		}
	}
}
