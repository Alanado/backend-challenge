import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { newSqsClient, TestEventConsumer } from "../support/event-consumer";
import {
	createPublisherRig,
	insertOutbox,
	type PublisherRig,
} from "../support/outbox-env";
import { connect } from "../support/sql";
import { SteppingClock } from "../support/submit-harness";
import {
	createSuiteDatabase,
	type SuiteDatabase,
} from "../support/suite-database";
import { createSuiteQueues, type SuiteQueues } from "../support/suite-queues";

const ROWS = 150;
const PUBLISHERS = 3;

let db: SuiteDatabase;
let queues: SuiteQueues;
let sql: Client;
const rigs: PublisherRig[] = [];

beforeAll(async () => {
	db = await createSuiteDatabase();
	queues = await createSuiteQueues("obxc06");
	sql = await connect(db.url);
});

afterAll(async () => {
	await Promise.all(rigs.map((rig) => rig.p.close()));
	await sql.end();
	await queues.destroy();
	await db.drop();
});

describe("TST-C-06 concurrent outbox publishers (real PostgreSQL and SQS)", () => {
	test("TST-C-06 (a) three publishers over 150 rows: every eventId arrives at least once, none fails, all end published", async () => {
		const clock = new SteppingClock();
		const ids = new Set<string>();
		for (let i = 0; i < ROWS; i++) {
			ids.add(
				await insertOutbox(sql, clock, {
					groupKey: `wallet-${i % 40}`,
					occurredAt: new Date(clock.now().getTime() + i),
					nextAttemptAt: clock.now(),
				}),
			);
		}
		for (let i = 0; i < PUBLISHERS; i++) {
			rigs.push(
				await createPublisherRig(db, {
					clock,
					queueName: queues.events.name,
					batchSize: 10,
				}),
			);
		}

		// Real parallelism: every publisher loops on its own pool until it finds nothing to claim.
		const claimedPerPublisher = await Promise.all(
			rigs.map(async (rig) => {
				let claimed = 0;
				for (;;) {
					const cycle = await rig.publisher.publishOnce();
					if (cycle.claimed === 0) return claimed;
					claimed += cycle.claimed;
				}
			}),
		);

		const rows = await sql.query(
			"select count(*)::int as total, count(published_at)::int as published, count(failed_at)::int as failed from outbox_messages",
		);
		expect(rows.rows[0]).toEqual({ total: ROWS, published: ROWS, failed: 0 });
		// More than one publisher did real work, and SKIP LOCKED gave nobody the same row twice here.
		expect(claimedPerPublisher.filter((n) => n > 0).length).toBeGreaterThan(1);
		expect(claimedPerPublisher.reduce((a, b) => a + b, 0)).toBe(ROWS);

		const sqs = newSqsClient();
		const consumer = new TestEventConsumer(sqs, queues.events.url);
		try {
			await consumer.pollUntil(() => consumer.inbox.size >= ROWS, 60_000);
		} finally {
			sqs.destroy();
		}
		expect(new Set(consumer.inbox.keys())).toEqual(ids);
		expect(consumer.deliveries.length).toBeGreaterThanOrEqual(ROWS);
	});
});
