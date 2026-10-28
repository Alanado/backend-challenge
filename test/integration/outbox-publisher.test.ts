import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DeleteQueueCommand, SQSClient } from "@aws-sdk/client-sqs";
import { OutboxPublisher } from "../../src/modules/messaging/application/outbox-publisher";
import { OutboxMessage } from "../../src/modules/messaging/domain/outbox-message";
import { SqsMessagePublisher } from "../../src/modules/messaging/infrastructure/sqs-message-publisher";
import {
	type CrashFn,
	SimulatedCrashError,
} from "../../src/shared/fault-injector";
import { newSqsClient, TestEventConsumer } from "../support/event-consumer";
import { eventually } from "../support/eventually";
import { uniqueId } from "../support/ids";
import {
	createFifoQueue,
	createOutboxEnv,
	createPublisherRig,
	insertOutbox,
	type OutboxEnv,
	outboxRow,
} from "../support/outbox-env";
import { createPersistence } from "../support/persistence";
import { connect } from "../support/sql";

let env: OutboxEnv;

beforeEach(async () => {
	env = await createOutboxEnv("obx");
});
afterEach(async () => {
	await env.close();
});

const throwCrash: CrashFn = (point) => {
	throw new SimulatedCrashError(point);
};

describe("TST-I-13 outbox publisher (real PostgreSQL and SQS)", () => {
	test("TST-I-13 publishes only after the commit of the effect", async () => {
		const { sql, clock, rig, consumer, db } = env;
		// The business side has its own pool and transaction manager, like another request would.
		const business = await createPersistence(db.url);
		try {
			const id = uniqueId();
			const message = OutboxMessage.rehydrate({
				id,
				aggregateId: uniqueId(),
				groupKey: uniqueId(),
				eventType: "WagerTransactionProcessed",
				payload: { eventId: id, eventType: "WagerTransactionProcessed" },
				occurredAt: clock.now(),
				attempts: 0,
				nextAttemptAt: clock.now(),
				publishedAt: undefined,
				failedAt: undefined,
				lastError: undefined,
			});

			await business.tm.run(async () => {
				await business.outbox.enqueue(message);
				// The business transaction is still open: the publisher must not see the event.
				const during = await rig.publisher.publishOnce();
				expect(during.claimed).toBe(0);
				expect(await consumer.pollOnce(1)).toBe(0);
			});

			const after = await rig.publisher.publishOnce();
			expect(after).toMatchObject({ claimed: 1, published: 1 });
			await consumer.pollUntil(() => consumer.inbox.has(id));
			expect(consumer.inbox.has(id)).toBe(true);
			expect((await outboxRow(sql, id)).published_at).not.toBeNull();
		} finally {
			await business.close();
		}
	});

	test("TST-I-13 a real partial batch failure marks only the rejected row as publish_failed", async () => {
		const { sql, clock, rig, consumer } = env;
		const good1 = await insertOutbox(sql, clock);
		const bad = await insertOutbox(sql, clock, { groupKey: "g".repeat(129) });
		const good2 = await insertOutbox(sql, clock);

		const result = await rig.publisher.publishOnce();

		expect(result).toMatchObject({ claimed: 3, published: 2, failed: 1 });
		const failed = await outboxRow(sql, bad);
		expect(failed.failed_at).not.toBeNull();
		expect(failed.published_at).toBeNull();
		expect(failed.last_error).toContain("InvalidParameterValue");
		expect(rig.metrics.outboxPublishFailures).toBe(1);
		expect(rig.logger.lines.filter((l) => l.level === "error")).toHaveLength(1);
		await consumer.pollUntil(() => consumer.inbox.size >= 2);
		expect([...consumer.inbox.keys()].sort()).toEqual([good1, good2].sort());
		// The permanent failure is not retried: the next cycle finds nothing to do.
		expect((await rig.publisher.publishOnce()).claimed).toBe(0);
	});

	test("TST-I-13 the eventId on the queue is the outbox id, the group is the walletId, and both are stable across resends", async () => {
		const crashing = await createOutboxEnv("obxc", {
			crash: { point: "crash-after-publish-before-commit", fn: throwCrash },
		});
		try {
			const walletId = uniqueId();
			const id = await insertOutbox(crashing.sql, crashing.clock, {
				groupKey: walletId,
			});

			await expect(crashing.rig.publisher.publishOnce()).rejects.toBeInstanceOf(
				SimulatedCrashError,
			);
			expect((await outboxRow(crashing.sql, id)).published_at).toBeNull();
			await crashing.consumer.pollUntil(() => crashing.consumer.inbox.has(id));
			expect(crashing.consumer.inbox.get(id)).toMatchObject({
				eventId: id,
				groupId: walletId,
			});

			// Same row, second publisher without the fault: it republishes the same eventId.
			const second = await createPublisherRig(crashing.db, {
				clock: crashing.clock,
				queueName: crashing.queues.events.name,
			});
			try {
				expect(await second.publisher.publishOnce()).toMatchObject({
					published: 1,
				});
			} finally {
				await second.p.close();
			}
			expect((await outboxRow(crashing.sql, id)).published_at).not.toBeNull();
			expect(crashing.consumer.deliveries.every((d) => d.eventId === id)).toBe(
				true,
			);
		} finally {
			await crashing.close();
		}
	});

	test("TST-I-13 a duplicate publication is safe: the test consumer sees the eventId again and deduplicates", async () => {
		const crashing = await createOutboxEnv("obxd", {
			crash: { point: "crash-after-publish-before-commit", fn: throwCrash },
		});
		try {
			const id = await insertOutbox(crashing.sql, crashing.clock);
			await expect(crashing.rig.publisher.publishOnce()).rejects.toBeInstanceOf(
				SimulatedCrashError,
			);
			const second = await createPublisherRig(crashing.db, {
				clock: crashing.clock,
				queueName: crashing.queues.events.name,
			});
			try {
				await second.publisher.publishOnce();
			} finally {
				await second.p.close();
			}
			await crashing.consumer.pollUntil(() => crashing.consumer.inbox.has(id));
			// Two sends of the same eventId (the crashed one and the resend) are one delivery:
			// the broker deduplicates on MessageDeduplicationId = eventId.
			expect(await crashing.consumer.pollOnce(1)).toBe(0);
			expect(crashing.consumer.deliveries).toHaveLength(1);
			const first = crashing.consumer.inbox.get(id);
			expect(first).toBeDefined();
			if (first === undefined) return;

			// FIFO already collapses a resend inside its 5-minute window (same MessageDeduplicationId,
			// = eventId). Past the window the broker delivers it twice; simulate that by sending the
			// same envelope with a different deduplication id.
			await crashing.consumer.injectDuplicate(first);
			await crashing.consumer.pollUntil(
				() => crashing.consumer.deliveries.length >= 2,
			);

			expect(crashing.consumer.deliveries.map((d) => d.eventId)).toEqual([
				id,
				id,
			]);
			expect(crashing.consumer.inbox.size).toBe(1);
		} finally {
			await crashing.close();
		}
	});

	test("TST-I-13 a missing queue is transient: attempts grow with backoff, then the rows publish once the queue exists", async () => {
		const { sql, clock, db, queues } = env;
		const missing = `obx-missing-${uniqueId().slice(-12)}.fifo`;
		const rig = await createPublisherRig(db, { clock, queueName: missing });
		try {
			const id = await insertOutbox(sql, clock);

			expect(await rig.publisher.publishOnce()).toMatchObject({
				claimed: 1,
				retried: 1,
				published: 0,
			});
			const first = await outboxRow(sql, id);
			expect(first).toMatchObject({ attempts: 1, failed_at: null });
			expect(first.published_at).toBeNull();
			expect(first.next_attempt_at.getTime()).toBe(
				clock.now().getTime() + 1000,
			);

			// Not due yet: the next cycle does not touch it.
			expect((await rig.publisher.publishOnce()).claimed).toBe(0);

			clock.advance(1000);
			await rig.publisher.publishOnce();
			const second = await outboxRow(sql, id);
			expect(second.attempts).toBe(2);
			expect(second.next_attempt_at.getTime()).toBe(
				clock.now().getTime() + 2000,
			);
			expect(rig.metrics.retries).toEqual(["outbox", "outbox"]);

			const url = await createFifoQueue(missing);
			const consumer = new TestEventConsumer(newSqsClient(), url);
			try {
				await eventually(
					async () => {
						clock.advance(61_000);
						await rig.publisher.publishOnce();
						expect((await outboxRow(sql, id)).published_at).not.toBeNull();
					},
					{ timeout: 10_000, interval: 100 },
				);
				await consumer.pollUntil(() => consumer.inbox.has(id));
				expect(consumer.inbox.has(id)).toBe(true);
			} finally {
				const sqs = newSqsClient();
				await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
				sqs.destroy();
			}
		} finally {
			await rig.p.close();
		}
		expect(queues.events.name).not.toBe(missing);
	});

	test("TST-I-13 rows locked by another transaction are skipped without waiting, and published once released", async () => {
		const { sql, clock, rig, consumer, db } = env;
		const locked = await insertOutbox(sql, clock);
		const free1 = await insertOutbox(sql, clock);
		const free2 = await insertOutbox(sql, clock);
		const holder = await connect(db.url);
		try {
			await holder.query("begin");
			await holder.query(
				"select id from outbox_messages where id = $1 for update",
				[locked],
			);

			const startedAt = performance.now();
			const result = await rig.publisher.publishOnce();
			const elapsedMs = performance.now() - startedAt;

			expect(result).toMatchObject({ claimed: 2, published: 2 });
			// lock_timeout is 5 s: waiting on the locked row would take at least that long.
			expect(elapsedMs).toBeLessThan(2500);
			expect((await outboxRow(sql, locked)).published_at).toBeNull();
			expect((await outboxRow(sql, free1)).published_at).not.toBeNull();
			expect((await outboxRow(sql, free2)).published_at).not.toBeNull();

			await holder.query("rollback");
			expect(await rig.publisher.publishOnce()).toMatchObject({
				claimed: 1,
				published: 1,
			});
			await consumer.pollUntil(() => consumer.inbox.size >= 3);
			expect(consumer.inbox.size).toBe(3);
		} finally {
			await holder.end();
		}
	});

	test("TST-I-13 outbox_lag_seconds reflects the oldest waiting event and returns to 0 once published", async () => {
		const { sql, clock, rig } = env;
		const tenMinutesAgo = new Date(clock.now().getTime() - 600_000);
		const id = await insertOutbox(sql, clock, {
			occurredAt: tenMinutesAgo,
			nextAttemptAt: new Date(clock.now().getTime() + 30_000),
		});

		// Waiting (backing off), not due: nothing is sent, but the lag is real.
		expect((await rig.publisher.publishOnce()).claimed).toBe(0);
		expect(rig.metrics.outboxLagSeconds).toBe(600);

		clock.advance(31_000);
		await rig.publisher.publishOnce();
		expect((await outboxRow(sql, id)).published_at).not.toBeNull();
		expect(rig.metrics.outboxLagSeconds).toBe(0);
	});

	test("TST-I-13 a message above the SQS size limit is a permanent failure, not a retry loop", async () => {
		const { sql, clock, rig } = env;
		const id = await insertOutbox(sql, clock, { paddingBytes: 300_000 });

		const result = await rig.publisher.publishOnce();

		expect(result).toMatchObject({ claimed: 1, failed: 1, published: 0 });
		const row = await outboxRow(sql, id);
		expect(row.failed_at).not.toBeNull();
		expect(row.last_error).toBe("MessageTooLong");
		expect(row.attempts).toBe(0);
	});

	test("TST-I-13 a SQS error that is not recognizably permanent never drops the event", async () => {
		const { sql, clock, db } = env;
		const unreachable = await createPersistence_unreachable(db, clock);
		try {
			const id = await insertOutbox(sql, clock);
			const result = await unreachable.publisher.publishOnce();
			expect(result).toMatchObject({ retried: 1, failed: 0 });
			expect((await outboxRow(sql, id)).failed_at).toBeNull();
		} finally {
			await unreachable.p.close();
		}
	});
});

/** A publisher whose SQS endpoint refuses connections (network failure). */
async function createPersistence_unreachable(
	db: OutboxEnv["db"],
	clock: OutboxEnv["clock"],
) {
	const rig = await createPublisherRig(db, {
		clock,
		queueName: "irrelevant.fifo",
	});
	const dead = new SQSClient({
		region: "us-east-1",
		endpoint: "http://127.0.0.1:1",
		credentials: { accessKeyId: "test", secretAccessKey: "test" },
		maxAttempts: 1,
	});
	const publisher = new OutboxPublisher({
		tm: rig.p.tm,
		outbox: rig.p.outbox,
		publisher: new SqsMessagePublisher({
			client: dead,
			queueUrl: "http://127.0.0.1:1/000000000000/q.fifo",
			queueName: "q.fifo",
		}),
		clock,
		metrics: rig.metrics,
		logger: rig.logger,
		faults: { check() {} },
		batchSize: 10,
		backoff: { baseMs: 1000, capMs: 60_000 },
	});
	return { p: rig.p, publisher };
}
