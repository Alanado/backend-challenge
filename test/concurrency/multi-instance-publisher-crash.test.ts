import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { newSqsClient, TestEventConsumer } from "../support/event-consumer";
import { eventually } from "../support/eventually";
import { insertOutbox } from "../support/outbox-env";
import { Fleet } from "../support/spawnApp";
import { connect } from "../support/sql";
import { queueDepth } from "../support/sqs-poller";
import { SteppingClock } from "../support/submit-harness";
import {
	createSuiteDatabase,
	type SuiteDatabase,
} from "../support/suite-database";
import { createSuiteQueues, type SuiteQueues } from "../support/suite-queues";

let db: SuiteDatabase;
let queues: SuiteQueues;
const fleet = new Fleet();
const sqs = newSqsClient();

const EVENTS = 25;
const BATCH = 10;

beforeAll(async () => {
	db = await createSuiteDatabase();
	queues = await createSuiteQueues("c06");
});

afterAll(async () => {
	await fleet.stopAll();
	sqs.destroy();
	await queues.destroy();
	await db.drop();
});

describe("TST-C-06 publishers on one outbox (real processes, real PostgreSQL and SQS)", () => {
	test("TST-C-06 (b) a publisher dies after sending the batch and before the commit; two other instances republish the same eventIds and every event arrives", async () => {
		const sql = await connect(db.url);
		try {
			await fleet.withOutputOnFailure(async () => {
				// Committed outbox rows, none published yet (no publisher is running).
				const clock = new SteppingClock();
				const occurredAt = Date.now() - 60_000;
				const ids: string[] = [];
				for (let i = 0; i < EVENTS; i++) {
					ids.push(
						await insertOutbox(sql, clock, {
							occurredAt: new Date(occurredAt + i),
						}),
					);
				}
				const publisherOnly = {
					db,
					queues,
					roles: { consumer: false, pendingWorker: false },
					env: { OUTBOX_BATCH: String(BATCH) },
				} as const;

				const doomed = await fleet.start(
					{
						...publisherOnly,
						fault: "crash-after-publish-before-commit",
						waitFor: "none",
					},
					"doomed",
				);
				const exit = await Promise.race([
					doomed.exited,
					new Promise<never>((_, reject) =>
						setTimeout(
							() => reject(new Error("the publisher never died")),
							30_000,
						),
					),
				]);
				expect(exit).toEqual({ exitCode: null, signalCode: "SIGKILL" });

				// It sent a whole batch and committed nothing: every row is still unpublished...
				const unpublished = await sql.query(
					"select count(*)::int as n from outbox_messages where published_at is null",
				);
				expect(unpublished.rows[0].n).toBe(EVENTS);
				// ...while the broker already holds that batch.
				expect(await queueDepth(sqs, queues.events.url)).toBe(BATCH);

				const consumer = new TestEventConsumer(sqs, queues.events.url);
				await consumer.pollUntil(() => consumer.inbox.size >= BATCH, 15_000);
				const sentByTheDead = [...consumer.inbox.keys()];
				expect(sentByTheDead).toHaveLength(BATCH);
				for (const eventId of sentByTheDead) expect(ids).toContain(eventId);

				// Two other instances, at the same time, take over the same outbox.
				await Promise.all([
					fleet.start({ ...publisherOnly, waitFor: "ready" }, "survivor-1"),
					fleet.start({ ...publisherOnly, waitFor: "ready" }, "survivor-2"),
				]);
				await eventually(
					async () => {
						const pending = await sql.query(
							"select count(*)::int as n from outbox_messages where published_at is null and failed_at is null",
						);
						expect(pending.rows[0].n).toBe(0);
					},
					{ timeout: 30_000, interval: 200 },
				);
				await consumer.pollUntil(() => consumer.inbox.size >= EVENTS, 15_000);

				// Every expected event arrived, under the very eventId it had in the outbox.
				expect([...consumer.inbox.keys()].sort()).toEqual([...ids].sort());
				expect(consumer.deliveries.length).toBeGreaterThanOrEqual(EVENTS);
				for (const eventId of sentByTheDead) {
					expect(consumer.inbox.has(eventId)).toBe(true);
				}
				const failed = await sql.query(
					"select count(*)::int as n from outbox_messages where failed_at is not null",
				);
				expect(failed.rows[0].n).toBe(0);
			});
		} finally {
			await sql.end();
		}
	}, 120_000);
});
