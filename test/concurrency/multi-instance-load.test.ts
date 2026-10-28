import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { newSqsClient, TestEventConsumer } from "../support/event-consumer";
import { eventually } from "../support/eventually";
import type { Reply, TestWallet } from "../support/http-app";
import {
	assertAllConsistent,
	createWalletOn,
	deadlocksOf,
	mapPool,
	type Op,
	op,
	sendOn,
	shuffled,
	submitOn,
	walletBalance,
} from "../support/multi-instance";
import { createPersistence, type Persistence } from "../support/persistence";
import { Fleet, type Instance } from "../support/spawnApp";
import { connect } from "../support/sql";
import { queueDepth } from "../support/sqs-poller";
import {
	createSuiteDatabase,
	type SuiteDatabase,
} from "../support/suite-database";
import { createSuiteQueues, type SuiteQueues } from "../support/suite-queues";

let db: SuiteDatabase;
let queues: SuiteQueues;
let p: Persistence;
const fleet = new Fleet();
const sqs = newSqsClient();

beforeAll(async () => {
	db = await createSuiteDatabase();
	queues = await createSuiteQueues("c04");
	p = await createPersistence(db.url);
});

afterAll(async () => {
	await fleet.stopAll();
	await p.close();
	sqs.destroy();
	await queues.destroy();
	await db.drop();
});

const WALLETS = 6;
const OPS_PER_WALLET = 20;

interface Planned {
	wallet: TestWallet;
	operation: Op;
}

describe("TST-C-04 three instances at once, HTTP and SQS together (real processes, real PostgreSQL and SQS)", () => {
	test("TST-C-04 round-robin HTTP plus SQS, every operation delivered three times: each applied exactly once, ledger consistent, no 5xx", async () => {
		const sql = await connect(db.url);
		try {
			await fleet.withOutputOnFailure(async () => {
				const instances: Instance[] = await fleet.startMany(3, {
					db,
					queues,
					waitFor: "ready",
				});
				const bases = instances.map((i) => i.base);
				const roundRobin = (n: number) => bases[n % bases.length] as string;

				const wallets = await Promise.all(
					Array.from({ length: WALLETS }, (_, i) =>
						createWalletOn(roundRobin(i), "1000.00"),
					),
				);
				const planned: Planned[] = wallets.flatMap((wallet) =>
					Array.from({ length: OPS_PER_WALLET }, () => ({
						wallet,
						operation: op("BET", "1.00"),
					})),
				);

				// Each operation arrives twice over HTTP (two different instances) and once over SQS,
				// all of it in one burst.
				const httpDeliveries = shuffled(
					planned.flatMap((entry) => [entry, entry]),
					7,
				);
				const startedAt = performance.now();
				const [replies] = await Promise.all([
					mapPool(httpDeliveries, 40, async (entry, index) => ({
						entry,
						reply: await submitOn(
							roundRobin(index),
							entry.wallet,
							entry.operation,
						),
					})),
					mapPool(shuffled(planned, 11), 20, (entry) =>
						sendOn(sqs, queues, entry.wallet, entry.operation),
					),
				]);
				const burstMs = Math.round(performance.now() - startedAt);

				// No 5xx, and for one operation every HTTP answer names the same transaction.
				const byOperation = new Map<string, Reply[]>();
				for (const { entry, reply } of replies) {
					expect([200, 201]).toContain(reply.status);
					const key = entry.operation.key;
					byOperation.set(key, [...(byOperation.get(key) ?? []), reply]);
				}
				for (const group of byOperation.values()) {
					expect(group).toHaveLength(2);
					expect(new Set(group.map((r) => r.body.transactionId)).size).toBe(1);
					expect(
						group.filter((r) => r.status === 201).length,
					).toBeLessThanOrEqual(1);
					expect(group.every((r) => r.body.status === "PROCESSED")).toBe(true);
				}

				// The SQS side drains too.
				await eventually(
					async () => expect(await queueDepth(sqs, queues.main.url)).toBe(0),
					{ timeout: 60_000, interval: 250 },
				);

				// Exactly one effect per operation, wallet by wallet.
				for (const wallet of wallets) {
					expect(await walletBalance(sql, wallet.id)).toBe(
						(1000 - OPS_PER_WALLET).toFixed(2),
					);
					const rows = await sql.query(
						`select external_transaction_id, status from wager_transactions
						  where wallet_id = $1 and kind = 'BET'`,
						[wallet.id],
					);
					expect(rows.rows).toHaveLength(OPS_PER_WALLET);
					expect(
						new Set(rows.rows.map((r) => r.external_transaction_id)).size,
					).toBe(OPS_PER_WALLET);
					expect(rows.rows.every((r) => r.status === "PROCESSED")).toBe(true);
					const ledger = await sql.query(
						"select count(*)::int as n from wallet_ledger_entries where wallet_id = $1",
						[wallet.id],
					);
					expect(ledger.rows[0].n).toBe(OPS_PER_WALLET + 1);
				}
				await assertAllConsistent(
					p,
					wallets.map((w) => w.id),
				);

				// The instances' own books agree: 120 operations applied in total, across processes.
				const applied = await Promise.all(
					instances.map((i) =>
						i.metric("wager_transactions_total", {
							kind: "BET",
							status: "PROCESSED",
						}),
					),
				);
				expect(applied.reduce((a, b) => a + b, 0)).toBe(
					WALLETS * OPS_PER_WALLET,
				);
				// Round-robin gave each instance an equal share of the HTTP requests.
				for (const instance of instances) {
					const http =
						(await instance.metric("wager_transactions_total", {
							channel: "http",
							kind: "BET",
						})) +
						(await instance.metric("idempotent_requests_total", {
							channel: "http",
							outcome: "replay",
						}));
					expect(http).toBe(httpDeliveries.length / instances.length);
					expect(await instance.metric("lock_conflicts_total")).toBe(0);
					expect(await instance.metric("dlq_messages_total")).toBe(0);
				}
				expect(await queueDepth(sqs, queues.dlq.url)).toBe(0);

				// The outbox emptied through the three publishers, each event under its own id.
				const outbox = await sql.query("select id from outbox_messages");
				expect(outbox.rowCount).toBe(WALLETS * (1 + 2 * OPS_PER_WALLET));
				await eventually(
					async () => {
						const pending = await sql.query(
							"select count(*)::int as n from outbox_messages where published_at is null",
						);
						expect(pending.rows[0].n).toBe(0);
					},
					{ timeout: 30_000, interval: 200 },
				);
				const consumer = new TestEventConsumer(sqs, queues.events.url);
				await consumer.pollUntil(
					() => consumer.inbox.size >= (outbox.rowCount ?? 0),
					30_000,
				);
				expect([...consumer.inbox.keys()].sort()).toEqual(
					outbox.rows.map((r) => r.id as string).sort(),
				);
				expect(await deadlocksOf(sql, db.name)).toBe(0);
				console.log(
					`C-04: ${httpDeliveries.length} HTTP + ${planned.length} SQS deliveries in ${burstMs} ms`,
				);
			});
		} finally {
			await sql.end();
		}
	}, 180_000);
});
