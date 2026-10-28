import {
	GetQueueUrlCommand,
	SendMessageBatchCommand,
	type SendMessageBatchResultEntry,
	SQSClient,
} from "@aws-sdk/client-sqs";
import { Injectable } from "@nestjs/common";
import {
	MessagePublisher,
	type PublishEntry,
	type PublishOutcome,
} from "../application/message-publisher";

/** SQS limit for the body of one message (256 KiB). */
export const SQS_MAX_MESSAGE_BYTES = 262_144;
/** SQS limit for the sum of the bodies of one SendMessageBatch (also 256 KiB). */
export const SQS_MAX_BATCH_BYTES = 262_144;
export const SEND_TIMEOUT_MS = 3000;

/** Splits `entries` (in order) into sub-batches whose bodies add up to at most `maxBytes`. */
export function chunkBySize(
	entries: readonly PublishEntry[],
	maxBytes: number = SQS_MAX_BATCH_BYTES,
): PublishEntry[][] {
	const chunks: PublishEntry[][] = [];
	let current: PublishEntry[] = [];
	let bytes = 0;
	for (const entry of entries) {
		const size = Buffer.byteLength(entry.body, "utf8");
		if (current.length > 0 && bytes + size > maxBytes) {
			chunks.push(current);
			current = [];
			bytes = 0;
		}
		current.push(entry);
		bytes += size;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

export interface SqsMessagePublisherOptions {
	client: SQSClient;
	/** Either the url or the name is enough; the name is resolved lazily (the queue may not exist yet). */
	queueUrl?: string | undefined;
	queueName: string;
	timeoutMs?: number;
}

/**
 * Error names that mean "this message itself is unacceptable" (03-messaging §6.2). Everything
 * else (network, throttling, 5xx, missing queue, credentials, timeout, unknown) is transient.
 */
const PERMANENT_NAME =
	/^(AWS\.SimpleQueueService\.)?(InvalidParameterValue|InvalidMessageContents|InvalidAttributeValue|BatchRequestTooLong|MessageTooLong)/;

function errorName(error: unknown): string {
	if (typeof error !== "object" || error === null) return "UnknownError";
	const e = error as { name?: unknown; Code?: unknown };
	return typeof e.Code === "string"
		? e.Code
		: typeof e.name === "string"
			? e.name
			: "UnknownError";
}

const transient = (id: string, error: string): PublishOutcome => ({
	id,
	status: "transient",
	error,
});
const permanent = (id: string, error: string): PublishOutcome => ({
	id,
	status: "permanent",
	error,
});

/** `SendMessageBatch` on the events FIFO queue: group = walletId, deduplication id = eventId. */
@Injectable()
export class SqsMessagePublisher extends MessagePublisher {
	private resolvedUrl: string | undefined;
	private readonly client: SQSClient;
	private readonly queueName: string;
	private readonly timeoutMs: number;

	constructor(options: SqsMessagePublisherOptions) {
		super();
		this.client = options.client;
		this.queueName = options.queueName;
		this.resolvedUrl = options.queueUrl;
		this.timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS;
	}

	async publishBatch(entries: PublishEntry[]): Promise<PublishOutcome[]> {
		const outcomes: PublishOutcome[] = [];
		const sendable: PublishEntry[] = [];
		for (const entry of entries) {
			if (Buffer.byteLength(entry.body, "utf8") > SQS_MAX_MESSAGE_BYTES) {
				outcomes.push(permanent(entry.id, "MessageTooLong"));
			} else {
				sendable.push(entry);
			}
		}
		const sent = await Promise.all(
			chunkBySize(sendable).map((chunk) => this.send(chunk)),
		);
		return [...outcomes, ...sent.flat()];
	}

	private async send(entries: PublishEntry[]): Promise<PublishOutcome[]> {
		const signal = AbortSignal.timeout(this.timeoutMs);
		try {
			const queueUrl = await this.queueUrl(signal);
			const result = await this.client.send(
				new SendMessageBatchCommand({
					QueueUrl: queueUrl,
					Entries: entries.map((entry) => ({
						Id: entry.id,
						MessageBody: entry.body,
						MessageGroupId: entry.groupKey,
						MessageDeduplicationId: entry.id,
					})),
				}),
				{ abortSignal: signal },
			);
			return this.perEntry(entries, result.Successful ?? [], result.Failed);
		} catch (error) {
			const name = errorName(error);
			// A request-level "unacceptable" error says nothing about which entry is to blame:
			// isolate them, so only the guilty one is marked permanent.
			if (PERMANENT_NAME.test(name) && entries.length > 1) {
				const split = await Promise.all(entries.map((e) => this.send([e])));
				return split.flat();
			}
			const status = PERMANENT_NAME.test(name) ? permanent : transient;
			return entries.map((entry) => status(entry.id, name));
		}
	}

	private perEntry(
		entries: PublishEntry[],
		successful: SendMessageBatchResultEntry[],
		failed: Array<{ Id?: string; Code?: string }> | undefined,
	): PublishOutcome[] {
		const ok = new Set(successful.map((s) => s.Id));
		const failures = new Map(failed?.map((f) => [f.Id, f.Code ?? "Unknown"]));
		return entries.map((entry) => {
			if (ok.has(entry.id)) return { id: entry.id, status: "published" };
			const code = failures.get(entry.id);
			if (code === undefined) {
				return transient(entry.id, "MissingBatchResult");
			}
			return PERMANENT_NAME.test(code)
				? permanent(entry.id, code)
				: transient(entry.id, code);
		});
	}

	/** A failed lookup is never cached: the queue may be created later (03-messaging §6.2). */
	private async queueUrl(signal: AbortSignal): Promise<string> {
		if (this.resolvedUrl !== undefined) return this.resolvedUrl;
		const found = await this.client.send(
			new GetQueueUrlCommand({ QueueName: this.queueName }),
			{ abortSignal: signal },
		);
		if (found.QueueUrl === undefined) throw new Error("QueueUrlMissing");
		this.resolvedUrl = found.QueueUrl;
		return found.QueueUrl;
	}
}
