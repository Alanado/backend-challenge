import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { newSqsClient } from "../support/event-consumer";
import { eventually, holdsFor } from "../support/eventually";
import type { TestWallet } from "../support/http-app";
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
import { Fleet } from "../support/spawnApp";
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
	queues = await createSuiteQueues("c10");
	p = await createPersistence(db.url);
});

afterAll(async () => {
	await fleet.stopAll();
	await p.close();
	sqs.destroy();
	await queues.destroy();
	await db.drop();
});

const WALLETS = 12;

interface WalletPlan {
	wallet: TestWallet;
	/** Delivered before the reference exists: they wait as PENDING_REFERENCE. */
	early: Op[];
	/** Everything else, in one shuffled burst. */
	burst: Op[];
}

/**
 * Per wallet, from 200.00: six BETs of 10.00; a REFUND of the first, a ROLLBACK of the second, a
 * WIN of 5.00 on the third, a LOSS on the fifth, and a REFUND of the fourth that arrives BEFORE
 * the fourth BET (pending, then resolved by a worker). Outcome: 11 transactions, all PROCESSED,
 * balance 200 - 60 + 10 + 10 + 5 + 10 = 175.00.
 */
function plan(wallet: TestWallet): WalletPlan {
	const bets = Array.from({ length: 6 }, () => op("BET", "10.00"));
	const [b1, b2, b3, b4, b5] = bets as [Op, Op, Op, Op, Op];
	return {
		wallet,
		early: [op("REFUND", "10.00", b4)],
		burst: [
			...bets,
			op("REFUND", "10.00", b1),
			op("ROLLBACK", "10.00", b2),
			op("WIN", "5.00", b3),
			op("LOSS", "10.00", b5),
		],
	};
}

describe("TST-C-10 mixed load on three instances (real processes, real PostgreSQL and SQS)", () => {
	test("TST-C-10 many wallets, duplicates on both channels, reversals and pending references: no deadlock anywhere", async () => {
		const sql = await connect(db.url);
		try {
			await fleet.withOutputOnFailure(async () => {
				const instances = await fleet.startMany(3, {
					db,
					queues,
					waitFor: "ready",
					env: { PENDING_REF_CAP_MS: "1000", PENDING_REF_MAX_ATTEMPTS: "30" },
				});
				const roundRobin = (n: number) =>
					(instances[n % instances.length] as (typeof instances)[number]).base;
				const deadlocksBefore = await deadlocksOf(sql, db.name);

				const wallets = await Promise.all(
					Array.from({ length: WALLETS }, (_, i) =>
						createWalletOn(roundRobin(i), "200.00"),
					),
				);
				const plans = wallets.map(plan);
				const statuses: number[] = [];

				// 1. The dependents arrive first, once over HTTP and once over SQS: all pending.
				await mapPool(
					plans.flatMap((w) => w.early.map((operation) => ({ w, operation }))),
					20,
					async ({ w, operation }, i) => {
						statuses.push(
							(await submitOn(roundRobin(i), w.wallet, operation)).status,
						);
						await sendOn(sqs, queues, w.wallet, operation);
					},
				);
				await eventually(
					async () => {
						const pending = await sql.query(
							"select count(*)::int as n from wager_transactions where status = 'PENDING_REFERENCE'",
						);
						expect(pending.rows[0].n).toBe(WALLETS);
					},
					{ timeout: 30_000, interval: 100 },
				);

				// 2. The burst: every operation over HTTP twice (two instances) and over SQS once.
				const deliveries = plans.flatMap((w) =>
					w.burst.map((operation) => ({ w, operation })),
				);
				await Promise.all([
					mapPool(
						shuffled(
							deliveries.flatMap((d) => [d, d]),
							23,
						),
						48,
						async ({ w, operation }, i) => {
							statuses.push(
								(await submitOn(roundRobin(i), w.wallet, operation)).status,
							);
						},
					),
					mapPool(shuffled(deliveries, 29), 24, ({ w, operation }) =>
						sendOn(sqs, queues, w.wallet, operation),
					),
				]);

				// No 5xx and no business rejection among everything the clients saw.
				expect(statuses.filter((s) => s >= 500)).toEqual([]);
				expect(
					statuses.filter((s) => s === 422 || s === 409 || s === 400),
				).toEqual([]);

				// Everything settles: pending ones resolved, the queue empty.
				await eventually(
					async () => {
						const open = await sql.query(
							"select count(*)::int as n from wager_transactions where status not in ('PROCESSED') and kind <> 'OPENING'",
						);
						expect(open.rows[0].n).toBe(0);
						expect(await queueDepth(sqs, queues.main.url)).toBe(0);
					},
					{ timeout: 90_000, interval: 250 },
				);

				for (const { wallet } of plans) {
					expect(await walletBalance(sql, wallet.id)).toBe("175.00");
					const rows = await sql.query(
						`select count(*)::int as n,
						        count(distinct external_transaction_id)::int as distinct_ids
						   from wager_transactions where wallet_id = $1 and kind <> 'OPENING'`,
						[wallet.id],
					);
					expect(rows.rows[0]).toEqual({ n: 11, distinct_ids: 11 });
					const ledger = await sql.query(
						"select count(*)::int as n from wallet_ledger_entries where wallet_id = $1",
						[wallet.id],
					);
					expect(ledger.rows[0].n).toBe(11); // opening + 6 BET + 2 refunds + rollback + win (LOSS moves nothing)
				}
				await assertAllConsistent(
					p,
					wallets.map((w) => w.id),
				);
				expect(await queueDepth(sqs, queues.dlq.url)).toBe(0);

				// Zero deadlocks, seen by the database and by every instance. PostgreSQL publishes its
				// statistics a moment after the work ends, so the zero is watched for a while.
				await holdsFor(
					2000,
					async () => {
						expect(await deadlocksOf(sql, db.name)).toBe(deadlocksBefore);
					},
					250,
				);
				for (const instance of instances) {
					expect(
						await instance.metric("lock_conflicts_total", { type: "deadlock" }),
					).toBe(0);
				}
			});
		} finally {
			await sql.end();
		}
	}, 180_000);
});
