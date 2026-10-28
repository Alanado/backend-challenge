import {
	DeleteMessageBatchCommand,
	ReceiveMessageCommand,
	SendMessageCommand,
	SQSClient,
} from "@aws-sdk/client-sqs";
import { testInfra } from "./infra";

export interface ReceivedEvent {
	eventId: string;
	eventType: string;
	groupId: string;
	body: Record<string, unknown>;
}

export function newSqsClient(): SQSClient {
	return new SQSClient({
		region: testInfra.region,
		endpoint: testInfra.sqsEndpoint,
		credentials: testInfra.credentials,
	});
}

/**
 * Test-only consumer of the events queue. It keeps an inbox by `eventId` (in memory, test only)
 * so a duplicate delivery is recognised and ignored: this proves "a duplicate is safe". The
 * product's guarantee is the stable `eventId`, not this class.
 */
export class TestEventConsumer {
	/** Every delivery, duplicates included, in arrival order. */
	readonly deliveries: ReceivedEvent[] = [];
	/** The inbox: one entry per distinct eventId. */
	readonly inbox = new Map<string, ReceivedEvent>();

	constructor(
		private readonly sqs: SQSClient,
		private readonly queueUrl: string,
	) {}

	/** Receives (and deletes) whatever is available, waiting up to `waitS` for the first message. */
	async pollOnce(waitS = 1): Promise<number> {
		const response = await this.sqs.send(
			new ReceiveMessageCommand({
				QueueUrl: this.queueUrl,
				MaxNumberOfMessages: 10,
				WaitTimeSeconds: waitS,
				MessageSystemAttributeNames: ["MessageGroupId"],
			}),
		);
		const messages = response.Messages ?? [];
		for (const message of messages) {
			const body = JSON.parse(message.Body ?? "{}") as Record<string, unknown>;
			const event: ReceivedEvent = {
				eventId: String(body.eventId),
				eventType: String(body.eventType),
				groupId: message.Attributes?.MessageGroupId ?? "",
				body,
			};
			this.deliveries.push(event);
			if (!this.inbox.has(event.eventId)) this.inbox.set(event.eventId, event);
		}
		if (messages.length > 0) {
			await this.sqs.send(
				new DeleteMessageBatchCommand({
					QueueUrl: this.queueUrl,
					Entries: messages.map((m, i) => ({
						Id: String(i),
						ReceiptHandle: m.ReceiptHandle ?? "",
					})),
				}),
			);
		}
		return messages.length;
	}

	/** Polls until `done()` holds or the budget ends (then returns anyway; the caller asserts). */
	async pollUntil(done: () => boolean, timeoutMs = 15_000): Promise<void> {
		const deadline = performance.now() + timeoutMs;
		while (!done() && performance.now() < deadline) await this.pollOnce(1);
	}

	/** Injects a copy of an event with its own deduplication id, as after SQS's 5-minute window. */
	async injectDuplicate(event: ReceivedEvent): Promise<void> {
		await this.sqs.send(
			new SendMessageCommand({
				QueueUrl: this.queueUrl,
				MessageBody: JSON.stringify(event.body),
				MessageGroupId: event.groupId,
				MessageDeduplicationId: `${event.eventId}-window-expired-${crypto.randomUUID()}`,
			}),
		);
	}
}
