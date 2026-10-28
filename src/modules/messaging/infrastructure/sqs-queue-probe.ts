import {
	GetQueueAttributesCommand,
	GetQueueUrlCommand,
	type SQSClient,
} from "@aws-sdk/client-sqs";

export interface SqsQueueProbeOptions {
	client: SQSClient;
	/** Either the url or the name is enough; the name is resolved on each check until it succeeds. */
	queueUrl?: string | undefined;
	queueName: string;
}

/**
 * Readiness of one queue: `GetQueueAttributes` answers. A queue that does not exist (not created
 * yet, or deleted) fails the check, which is the point: this instance cannot do its job.
 */
export class SqsQueueProbe {
	private resolvedUrl: string | undefined;

	constructor(private readonly options: SqsQueueProbeOptions) {
		this.resolvedUrl = options.queueUrl;
	}

	async check(signal: AbortSignal): Promise<void> {
		const { client, queueName } = this.options;
		let url = this.resolvedUrl;
		if (url === undefined) {
			const found = await client.send(
				new GetQueueUrlCommand({ QueueName: queueName }),
				{
					abortSignal: signal,
				},
			);
			if (found.QueueUrl === undefined) throw new Error("QueueUrlMissing");
			url = found.QueueUrl;
		}
		await client.send(
			new GetQueueAttributesCommand({
				QueueUrl: url,
				AttributeNames: ["QueueArn"],
			}),
			{ abortSignal: signal },
		);
		this.resolvedUrl = url;
	}
}
