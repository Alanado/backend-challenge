import {
	GetQueueUrlCommand,
	SendMessageCommand,
	type SQSClient,
} from "@aws-sdk/client-sqs";
import {
	type DeadLetterFailure,
	DeadLetterQueue,
	type InboundMessage,
} from "../application/message-consumer";

export interface SqsDeadLetterQueueOptions {
	client: SQSClient;
	/** Either the url or the name is enough; the name is resolved lazily. */
	queueUrl?: string | undefined;
	queueName: string;
}

/**
 * `wager-transactions-dlq.fifo`. A FIFO queue demands a group and a deduplication id: the copy
 * reuses the original's, so a repeated send of the same message is one DLQ message, and the group
 * keeps the wallet's messages together. The body is untouched; the failure travels in attributes.
 */
export class SqsDeadLetterQueue extends DeadLetterQueue {
	private resolvedUrl: string | undefined;

	constructor(private readonly options: SqsDeadLetterQueueOptions) {
		super();
		this.resolvedUrl = options.queueUrl;
	}

	async send(
		message: InboundMessage,
		failure: DeadLetterFailure,
	): Promise<void> {
		await this.options.client.send(
			new SendMessageCommand({
				QueueUrl: await this.queueUrl(),
				MessageBody: message.body,
				MessageGroupId: message.groupId,
				MessageDeduplicationId: message.deduplicationId,
				MessageAttributes: {
					errorCode: { DataType: "String", StringValue: failure.errorCode },
					reason: { DataType: "String", StringValue: failure.reason },
				},
			}),
		);
	}

	private async queueUrl(): Promise<string> {
		if (this.resolvedUrl !== undefined) return this.resolvedUrl;
		const found = await this.options.client.send(
			new GetQueueUrlCommand({ QueueName: this.options.queueName }),
		);
		if (found.QueueUrl === undefined) throw new Error("QueueUrlMissing");
		this.resolvedUrl = found.QueueUrl;
		return found.QueueUrl;
	}
}
