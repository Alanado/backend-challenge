import { CreateQueueCommand, GetQueueUrlCommand } from "@aws-sdk/client-sqs";
import type { Client } from "pg";
import { OutboxPublisher } from "../../src/modules/messaging/application/outbox-publisher";
import { SqsMessagePublisher } from "../../src/modules/messaging/infrastructure/sqs-message-publisher";
import {
	type CrashFn,
	createFaultInjector,
} from "../../src/shared/fault-injector";
import { newSqsClient, TestEventConsumer } from "./event-consumer";
import { uniqueId } from "./ids";
import { createPersistence, type Persistence } from "./persistence";
import { connect } from "./sql";
import {
	RecordingLogger,
	RecordingMetrics,
	SteppingClock,
} from "./submit-harness";
import { createSuiteDatabase, type SuiteDatabase } from "./suite-database";
import { createSuiteQueues, type SuiteQueues } from "./suite-queues";

export interface PublisherRig {
	publisher: OutboxPublisher;
	metrics: RecordingMetrics;
	logger: RecordingLogger;
	p: Persistence;
}

export interface PublisherRigOptions {
	clock: SteppingClock;
	queueName: string;
	crash?: { point: string; fn: CrashFn };
	batchSize?: number;
}

/** A publisher on its own pool, pointed at the SQS queue called `queueName` (resolved lazily). */
export async function createPublisherRig(
	db: SuiteDatabase,
	options: PublisherRigOptions,
): Promise<PublisherRig> {
	const p = await createPersistence(db.url);
	const metrics = new RecordingMetrics();
	const logger = new RecordingLogger();
	const publisher = new OutboxPublisher({
		tm: p.tm,
		outbox: p.outbox,
		publisher: new SqsMessagePublisher({
			client: newSqsClient(),
			queueName: options.queueName,
		}),
		clock: options.clock,
		metrics,
		logger,
		faults: createFaultInjector(options.crash?.point ?? "", options.crash?.fn),
		batchSize: options.batchSize ?? 10,
		backoff: { baseMs: 1000, capMs: 60_000 },
	});
	return { publisher, metrics, logger, p };
}

export interface OutboxEnv {
	db: SuiteDatabase;
	sql: Client;
	queues: SuiteQueues;
	clock: SteppingClock;
	consumer: TestEventConsumer;
	rig: PublisherRig;
	close(): Promise<void>;
}

/** Fresh database + fresh queues + one publisher, so no test sees another's rows or messages. */
export async function createOutboxEnv(
	prefix: string,
	options: { crash?: PublisherRigOptions["crash"]; batchSize?: number } = {},
): Promise<OutboxEnv> {
	const db = await createSuiteDatabase();
	const queues = await createSuiteQueues(prefix);
	const sql = await connect(db.url);
	const clock = new SteppingClock();
	const sqs = newSqsClient();
	const rig = await createPublisherRig(db, {
		clock,
		queueName: queues.events.name,
		...options,
	});
	return {
		db,
		sql,
		queues,
		clock,
		consumer: new TestEventConsumer(sqs, queues.events.url),
		rig,
		async close() {
			await rig.p.close();
			await sql.end();
			await queues.destroy();
			await db.drop();
			sqs.destroy();
		},
	};
}

export interface OutboxRowSpec {
	id?: string;
	groupKey?: string;
	occurredAt?: Date;
	nextAttemptAt?: Date;
	/** Extra bytes in `payload.data.padding`, to build oversize messages. */
	paddingBytes?: number;
}

/** Inserts a committed outbox row (raw SQL on `sql`, i.e. its own connection). */
export async function insertOutbox(
	sql: Client,
	clock: SteppingClock,
	spec: OutboxRowSpec = {},
): Promise<string> {
	const id = spec.id ?? uniqueId();
	const occurredAt = spec.occurredAt ?? clock.now();
	const payload = {
		eventId: id,
		eventType: "WagerTransactionProcessed",
		aggregateId: uniqueId(),
		correlationId: "corr-test",
		occurredAt: occurredAt.toISOString(),
		version: 1,
		data:
			spec.paddingBytes === undefined
				? {}
				: { padding: "x".repeat(spec.paddingBytes) },
	};
	await sql.query(
		`insert into outbox_messages (id, aggregate_id, group_key, event_type, payload, occurred_at, next_attempt_at)
		 values ($1, $2, $3, $4, $5, $6, $7)`,
		[
			id,
			payload.aggregateId,
			spec.groupKey ?? uniqueId(),
			payload.eventType,
			JSON.stringify(payload),
			occurredAt,
			spec.nextAttemptAt ?? occurredAt,
		],
	);
	return id;
}

export interface OutboxRow {
	id: string;
	attempts: number;
	next_attempt_at: Date;
	published_at: Date | null;
	failed_at: Date | null;
	last_error: string | null;
}

export async function outboxRow(sql: Client, id: string): Promise<OutboxRow> {
	const result = await sql.query(
		"select id, attempts, next_attempt_at, published_at, failed_at, last_error from outbox_messages where id = $1",
		[id],
	);
	return result.rows[0] as OutboxRow;
}

/** Creates a FIFO queue by name, as an operator would after a deploy that forgot it. */
export async function createFifoQueue(name: string): Promise<string> {
	const sqs = newSqsClient();
	try {
		await sqs.send(
			new CreateQueueCommand({
				QueueName: name,
				Attributes: { FifoQueue: "true" },
			}),
		);
		const found = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
		if (found.QueueUrl === undefined) throw new Error("no queue url");
		return found.QueueUrl;
	} finally {
		sqs.destroy();
	}
}
