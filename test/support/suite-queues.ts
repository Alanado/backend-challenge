import {
	CreateQueueCommand,
	DeleteQueueCommand,
	GetQueueAttributesCommand,
	SQSClient,
} from "@aws-sdk/client-sqs";
import { testInfra } from "./infra";

export interface SuiteQueue {
	name: string;
	url: string;
	arn: string;
}

export interface SuiteQueues {
	suffix: string;
	main: SuiteQueue;
	dlq: SuiteQueue;
	events: SuiteQueue;
	destroy(): Promise<void>;
}

export interface SuiteQueuesOptions {
	/** Redrive threshold of the main queue (default 8, as in 02-design §9). */
	maxReceiveCount?: number;
	/** Main queue visibility timeout in seconds (default 30). */
	visibilityTimeoutS?: number;
	/** Main queue long-poll wait in seconds (default 20). */
	receiveWaitS?: number;
}

function newClient(): SQSClient {
	return new SQSClient({
		region: testInfra.region,
		endpoint: testInfra.sqsEndpoint,
		credentials: testInfra.credentials,
	});
}

/** Main FIFO + DLQ FIFO with redrive + events FIFO, all with a random suffix (isolated per suite). */
export async function createSuiteQueues(
	prefix: string,
	options: SuiteQueuesOptions = {},
): Promise<SuiteQueues> {
	const {
		maxReceiveCount = 8,
		visibilityTimeoutS = 30,
		receiveWaitS = 20,
	} = options;
	const sqs = newClient();
	const suffix = Bun.randomUUIDv7().replaceAll("-", "").slice(-12);

	async function create(
		name: string,
		attributes: Record<string, string>,
	): Promise<SuiteQueue> {
		const created = await sqs.send(
			new CreateQueueCommand({
				QueueName: name,
				Attributes: { FifoQueue: "true", ...attributes },
			}),
		);
		const url = created.QueueUrl;
		if (!url) throw new Error(`queue ${name} has no url`);
		const attrs = await sqs.send(
			new GetQueueAttributesCommand({
				QueueUrl: url,
				AttributeNames: ["QueueArn"],
			}),
		);
		const arn = attrs.Attributes?.QueueArn;
		if (!arn) throw new Error(`queue ${name} has no arn`);
		return { name, url, arn };
	}

	const dlq = await create(`${prefix}-${suffix}-dlq.fifo`, {});
	const main = await create(`${prefix}-${suffix}-main.fifo`, {
		VisibilityTimeout: String(visibilityTimeoutS),
		ReceiveMessageWaitTimeSeconds: String(receiveWaitS),
		RedrivePolicy: JSON.stringify({
			deadLetterTargetArn: dlq.arn,
			maxReceiveCount,
		}),
	});
	const events = await create(`${prefix}-${suffix}-events.fifo`, {});

	let destroyed = false;
	return {
		suffix,
		main,
		dlq,
		events,
		async destroy() {
			if (destroyed) return;
			destroyed = true;
			await Promise.all(
				[main, dlq, events].map((queue) =>
					sqs.send(new DeleteQueueCommand({ QueueUrl: queue.url })),
				),
			);
			sqs.destroy();
		},
	};
}
