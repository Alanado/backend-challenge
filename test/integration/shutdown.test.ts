import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { Client } from "pg";
import { assertLedgerInvariant } from "../support/assertLedgerInvariant";
import { wagerMessage } from "../support/consumer-env";
import { openWalletWithOpening } from "../support/domain-builders";
import { newSqsClient } from "../support/event-consumer";
import { eventually } from "../support/eventually";
import type { Reply, TestWallet } from "../support/http-app";
import { op, submitOn, walletBalance } from "../support/multi-instance";
import { createPersistence, type Persistence } from "../support/persistence";
import { Fleet, type Instance } from "../support/spawnApp";
import { connect } from "../support/sql";
import { queueCounts, sendMessage } from "../support/sqs-poller";
import {
	createSuiteDatabase,
	type SuiteDatabase,
} from "../support/suite-database";
import { createSuiteQueues, type SuiteQueues } from "../support/suite-queues";

let db: SuiteDatabase;
let queues: SuiteQueues;
let p: Persistence;
let sql: Client;
let fleet: Fleet;
const sqs = newSqsClient();

// Every test gets its own database, queues and instances: a failure cannot leak into the next one.
beforeEach(async () => {
	fleet = new Fleet();
	db = await createSuiteDatabase();
	queues = await createSuiteQueues("i18");
	p = await createPersistence(db.url);
	sql = await connect(db.url);
});

afterEach(async () => {
	await fleet.stopAll();
	await sql.end();
	await p.close();
	await queues.destroy();
	await db.drop();
});

afterAll(() => sqs.destroy());

/** A wallet with an opening balance, created straight in the database (no instance needed). */
async function newWallet(): Promise<TestWallet> {
	const wallet = await openWalletWithOpening(p, "100.00");
	return { id: wallet.id, playerId: wallet.playerId, currency: "BRL" };
}

/** A raw connection that holds `FOR UPDATE` on the wallets until `release()`: handlers pile up behind it. */
async function holdWalletLocks(walletIds: string[]) {
	const holder = await connect(db.url);
	await holder.query("begin");
	await holder.query("select id from wallets where id = any($1) for update", [
		walletIds,
	]);
	return {
		async release() {
			await holder.query("rollback");
			await holder.end();
		},
	};
}

async function waitingOnLocks(): Promise<number> {
	const result = await sql.query(
		"select count(*)::int as n from pg_stat_activity where datname = $1 and wait_event_type = 'Lock'",
		[db.name],
	);
	return result.rows[0].n as number;
}

async function exitsWithin(instance: Instance, ms: number) {
	return Promise.race([
		instance.exited,
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error(`still running after ${ms} ms`)), ms),
		),
	]);
}

async function ready(
	instance: Instance,
): Promise<{ status: number; body: unknown } | "refused"> {
	try {
		const response = await fetch(`${instance.base}/health/ready`);
		return { status: response.status, body: await response.json() };
	} catch {
		return "refused";
	}
}

/** Sends two BET messages of 5.00 to each wallet and returns their business ids. */
async function sendTwoEach(wallets: TestWallet[]): Promise<string[]> {
	const messageIds: string[] = [];
	for (const wallet of wallets) {
		for (let i = 0; i < 2; i++) {
			const message = wagerMessage(wallet, { amount: "5.00" });
			messageIds.push(message.messageId);
			await sendMessage(sqs, queues.main.url, message.body, wallet.id);
		}
	}
	return messageIds;
}

async function assertEachMessageAppliedOnce(
	messageIds: string[],
	wallets: TestWallet[],
	perWallet: number,
): Promise<void> {
	const inbox = await sql.query(
		"select message_id, processed_at from inbox_messages where message_id = any($1)",
		[messageIds],
	);
	expect(inbox.rowCount).toBe(messageIds.length);
	expect(inbox.rows.every((r) => r.processed_at !== null)).toBe(true);
	for (const wallet of wallets) {
		const bets = await sql.query(
			"select count(*)::int as n, count(distinct external_transaction_id)::int as d from wager_transactions where wallet_id = $1 and kind = 'BET'",
			[wallet.id],
		);
		expect(bets.rows[0]).toEqual({ n: perWallet, d: perWallet });
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	}
	expect(await queueCounts(sqs, queues.main.url)).toEqual({
		visible: 0,
		inFlight: 0,
		delayed: 0,
	});
	expect(await queueCounts(sqs, queues.dlq.url)).toEqual({
		visible: 0,
		inFlight: 0,
		delayed: 0,
	});
}

describe("TST-I-18 SIGTERM with work in flight (real process, real PostgreSQL and SQS)", () => {
	test("TST-I-18 readiness turns 503 right after the signal, the HTTP request in flight finishes, handlers conclude within the grace period, exit 0, nothing lost", async () => {
		await fleet.withOutputOnFailure(async () => {
			// Everything is in place before the instance starts: four wallets under a raw lock and
			// two messages for each of three of them, so its first fetch brings handlers for all three.
			const wallets = await Promise.all([
				newWallet(),
				newWallet(),
				newWallet(),
				newWallet(),
			]);
			const [w1, w2, w3, w4] = wallets as [
				TestWallet,
				TestWallet,
				TestWallet,
				TestWallet,
			];
			const locks = await holdWalletLocks(wallets.map((w) => w.id));
			const messageIds = await sendTwoEach([w1, w2, w3]);

			const instance = await fleet.start(
				{
					db,
					queues,
					waitFor: "ready",
					env: {
						LOCK_TIMEOUT_MS: "30000",
						SHUTDOWN_GRACE_MS: "20000",
						SHUTDOWN_DRAIN_DELAY_MS: "1500",
					},
				},
				"draining",
			);
			// Three handlers in flight plus one HTTP request in flight, all waiting for the wallet locks.
			const httpInFlight: Promise<Reply> = submitOn(
				instance.base,
				w4,
				op("BET", "5.00"),
			);
			await eventually(async () => expect(await waitingOnLocks()).toBe(4), {
				timeout: 20_000,
				interval: 50,
			});

			instance.kill("SIGTERM");

			// 1. Readiness: 503 and `draining`, while the instance still answers.
			const draining = await eventually(
				async () => {
					const answer = await ready(instance);
					if (answer === "refused") throw new Error("refused");
					expect(answer.status).toBe(503);
					return answer;
				},
				{ timeout: 1200, interval: 20 },
			);
			expect(draining.body).toMatchObject({
				status: "down",
				checks: { lifecycle: "down" },
			});
			expect((await fetch(`${instance.base}/health/live`)).status).toBe(200);

			// 2. The HTTP request in flight is not cut: it finishes once the lock is gone.
			await locks.release();
			const reply = await httpInFlight;
			expect(reply.status).toBe(201);
			expect(reply.body.status).toBe("PROCESSED");

			// 6. Clean exit, in time, without having had to give anything up.
			expect(await exitsWithin(instance, 30_000)).toEqual({
				exitCode: 0,
				signalCode: null,
			});
			expect(instance.stdout()).toContain('"event":"app_stopped"');
			expect(instance.stdout()).not.toContain("grace period");

			// New connections are refused once it is gone.
			expect(await ready(instance)).toBe("refused");

			// Nothing lost: another instance finishes whatever the first one left, each message once.
			await fleet.start(
				{
					db,
					queues,
					roles: { outboxPublisher: false, pendingWorker: false },
					waitFor: "ready",
				},
				"takeover",
			);
			await eventually(
				async () => {
					const counts = await queueCounts(sqs, queues.main.url);
					expect(counts).toEqual({ visible: 0, inFlight: 0, delayed: 0 });
				},
				{ timeout: 60_000, interval: 250 },
			);
			await assertEachMessageAppliedOnce(messageIds, [w1, w2, w3], 2);
			expect(await walletBalance(sql, w1.id)).toBe("90.00");
			expect(await walletBalance(sql, w4.id)).toBe("95.00");
			await assertLedgerInvariant(p.ledgerIntegrity, w4.id);
		});
	}, 180_000);

	test("TST-I-18 with a grace period too short, handlers still pending are returned to the queue (visibility 0), never deleted, and another instance finishes them once", async () => {
		await fleet.withOutputOnFailure(async () => {
			const wallets = await Promise.all([
				newWallet(),
				newWallet(),
				newWallet(),
			]);
			const locks = await holdWalletLocks(wallets.map((w) => w.id));
			const messageIds = await sendTwoEach(wallets);
			const instance = await fleet.start(
				{
					db,
					queues,
					waitFor: "ready",
					env: {
						LOCK_TIMEOUT_MS: "3000",
						SHUTDOWN_GRACE_MS: "500",
						SHUTDOWN_DRAIN_DELAY_MS: "0",
					},
				},
				"short-grace",
			);
			await eventually(async () => expect(await waitingOnLocks()).toBe(3), {
				timeout: 20_000,
				interval: 50,
			});
			expect(
				(await queueCounts(sqs, queues.main.url)).inFlight,
			).toBeGreaterThanOrEqual(3);

			instance.kill("SIGTERM");

			// Exits 0 on its own: the grace period (500 ms) plus the closing of the pool.
			expect(await exitsWithin(instance, 20_000)).toEqual({
				exitCode: 0,
				signalCode: null,
			});
			expect(instance.stdout()).toContain('"event":"app_stopped"');

			// Every message is back in the queue and deliverable now: none deleted, none still hidden.
			const counts = await queueCounts(sqs, queues.main.url);
			expect(counts.inFlight).toBe(0);
			expect(counts.visible).toBe(messageIds.length);
			for (const wallet of wallets) {
				expect(await walletBalance(sql, wallet.id)).toBe("100.00");
			}

			// The lock goes away, another instance takes over: each message exactly once.
			await locks.release();
			await fleet.start(
				{
					db,
					queues,
					roles: { outboxPublisher: false, pendingWorker: false },
					waitFor: "ready",
				},
				"takeover",
			);
			await eventually(
				async () => {
					expect(await queueCounts(sqs, queues.main.url)).toEqual({
						visible: 0,
						inFlight: 0,
						delayed: 0,
					});
				},
				{ timeout: 60_000, interval: 250 },
			);
			await assertEachMessageAppliedOnce(messageIds, wallets, 2);
			for (const wallet of wallets) {
				expect(await walletBalance(sql, wallet.id)).toBe("90.00");
			}
		});
	}, 180_000);
});
