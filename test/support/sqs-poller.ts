import {
	GetQueueAttributesCommand,
	SendMessageCommand,
	type SQSClient,
} from "@aws-sdk/client-sqs";
import type {
	InboundMessage,
	MessageOutcome,
} from "../../src/modules/messaging/application/message-consumer";

export async function sendMessage(
	sqs: SQSClient,
	queueUrl: string,
	body: string,
	groupId: string,
	deduplicationId: string = crypto.randomUUID(),
): Promise<void> {
	await sqs.send(
		new SendMessageCommand({
			QueueUrl: queueUrl,
			MessageBody: body,
			MessageGroupId: groupId,
			MessageDeduplicationId: deduplicationId,
		}),
	);
}

/** Visible + in flight + delayed: what the queue still holds. */
export async function queueDepth(
	sqs: SQSClient,
	queueUrl: string,
): Promise<number> {
	const response = await sqs.send(
		new GetQueueAttributesCommand({
			QueueUrl: queueUrl,
			AttributeNames: [
				"ApproximateNumberOfMessages",
				"ApproximateNumberOfMessagesNotVisible",
				"ApproximateNumberOfMessagesDelayed",
			],
		}),
	);
	const a = response.Attributes ?? {};
	return (
		Number(a.ApproximateNumberOfMessages ?? 0) +
		Number(a.ApproximateNumberOfMessagesNotVisible ?? 0) +
		Number(a.ApproximateNumberOfMessagesDelayed ?? 0)
	);
}

export interface HandlerCall {
	body: string;
	receiveCount: number;
	groupId: string;
}

/**
 * A handler that records every call and how many were running at once, overall and per group.
 * `behave` decides the outcome of each call (default: ack).
 */
export class RecordingHandler {
	readonly calls: HandlerCall[] = [];
	private active = 0;
	maxActive = 0;
	private readonly activeByGroup = new Map<string, number>();
	maxActiveInAGroup = 0;

	constructor(
		private readonly behave: (
			message: InboundMessage,
			call: HandlerCall,
		) => Promise<MessageOutcome> = async () => ({ kind: "ack" }),
	) {}

	readonly handle = async (
		message: InboundMessage,
	): Promise<MessageOutcome> => {
		const call: HandlerCall = {
			body: message.body,
			receiveCount: message.receiveCount,
			groupId: message.groupId,
		};
		this.calls.push(call);
		this.active += 1;
		this.maxActive = Math.max(this.maxActive, this.active);
		const inGroup = (this.activeByGroup.get(message.groupId) ?? 0) + 1;
		this.activeByGroup.set(message.groupId, inGroup);
		this.maxActiveInAGroup = Math.max(this.maxActiveInAGroup, inGroup);
		try {
			return await this.behave(message, call);
		} finally {
			this.active -= 1;
			this.activeByGroup.set(
				message.groupId,
				(this.activeByGroup.get(message.groupId) ?? 1) - 1,
			);
		}
	};

	bodies(): string[] {
		return this.calls.map((c) => c.body);
	}
}

/** A promise the test resolves by hand. */
export function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
