import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eventually } from "../support/eventually";
import type { Reply, TestWallet } from "../support/http-app";
import {
	assertAllConsistent,
	createWalletOn,
	type Op,
	op,
	submitOn,
	walletBalance,
} from "../support/multi-instance";
import { createPersistence, type Persistence } from "../support/persistence";
import { Fleet } from "../support/spawnApp";
import { connect } from "../support/sql";
import {
	createSuiteDatabase,
	type SuiteDatabase,
} from "../support/suite-database";
import { createSuiteQueues, type SuiteQueues } from "../support/suite-queues";

let db: SuiteDatabase;
let queues: SuiteQueues;
let p: Persistence;
const fleet = new Fleet();

beforeAll(async () => {
	db = await createSuiteDatabase();
	queues = await createSuiteQueues("c08");
	p = await createPersistence(db.url);
});

afterAll(async () => {
	await fleet.stopAll();
	await p.close();
	await queues.destroy();
	await db.drop();
});

interface Sent {
	wallet: TestWallet;
	operation: Op;
	/** What the client saw before the kill; `undefined` when the connection died first. */
	reply?: Reply;
}

describe("TST-C-08 the service is killed and started again (real processes, real PostgreSQL)", () => {
	test("TST-C-08 SIGKILL in the middle of traffic: the same operations sent to the new process are replays (or first applications), never second ones; consistent at the end", async () => {
		const sql = await connect(db.url);
		try {
			await fleet.withOutputOnFailure(async () => {
				const first = await fleet.start(
					{ db, queues, waitFor: "ready" },
					"before",
				);
				const wallets = await Promise.all([
					createWalletOn(first.base, "500.00"),
					createWalletOn(first.base, "500.00"),
				]);
				const wallet = (i: number) => wallets[i % wallets.length] as TestWallet;

				// 1. Traffic that was fully answered before the kill.
				const answered: Sent[] = [];
				for (let i = 0; i < 10; i++) {
					const entry: Sent = {
						wallet: wallet(i),
						operation: op("BET", "5.00"),
					};
					entry.reply = await submitOn(
						first.base,
						entry.wallet,
						entry.operation,
					);
					expect(entry.reply.status).toBe(201);
					answered.push(entry);
				}
				const balancesBefore = await Promise.all(
					wallets.map((w) => walletBalance(sql, w.id)),
				);
				expect(balancesBefore).toEqual(["475.00", "475.00"]);

				// 2. Traffic still in flight when the process is killed: some answers arrive, some do not.
				const inFlight: Sent[] = Array.from({ length: 40 }, (_, i) => ({
					wallet: wallet(i),
					operation: op("BET", "5.00"),
				}));
				let replied = 0;
				const settled = Promise.all(
					inFlight.map(async (entry) => {
						try {
							entry.reply = await submitOn(
								first.base,
								entry.wallet,
								entry.operation,
							);
							replied += 1;
						} catch {
							// connection reset by the kill: the client does not know the outcome
						}
					}),
				);
				await eventually(() => expect(replied).toBeGreaterThanOrEqual(5), {
					timeout: 20_000,
					interval: 5,
				});
				first.kill("SIGKILL");
				expect(await first.exited).toEqual({
					exitCode: null,
					signalCode: "SIGKILL",
				});
				await settled;

				// 3. A new process on the same database.
				const second = await fleet.start(
					{ db, queues, waitFor: "ready" },
					"after",
				);
				expect(second.pid).not.toBe(first.pid);

				// 3a. What had been answered replays exactly: 200, same transaction, flagged as replay.
				for (const entry of answered) {
					const replay = await submitOn(
						second.base,
						entry.wallet,
						entry.operation,
					);
					expect(replay.status).toBe(200);
					expect(replay.body.idempotentReplay).toBe(true);
					expect(replay.body.transactionId).toBe(
						entry.reply?.body.transactionId,
					);
					expect(replay.body).toEqual({
						...entry.reply?.body,
						idempotentReplay: true,
					});
				}
				// 3b. What was in flight: applied before the kill (200, replay, the very transaction the
				// client may have seen) or not applied at all (201, applied now). Never a second effect.
				let appliedBeforeTheKill = 0;
				for (const entry of inFlight) {
					const reply = await submitOn(
						second.base,
						entry.wallet,
						entry.operation,
					);
					expect([200, 201]).toContain(reply.status);
					expect(reply.body.status).toBe("PROCESSED");
					if (reply.status === 200) {
						appliedBeforeTheKill += 1;
						expect(reply.body.idempotentReplay).toBe(true);
					}
					if (entry.reply !== undefined) {
						// Answered 201 before the kill: the new process must say the same, as a replay.
						expect(reply.status).toBe(200);
						expect(reply.body.transactionId).toBe(
							entry.reply.body.transactionId,
						);
					}
				}
				expect(appliedBeforeTheKill).toBeGreaterThanOrEqual(replied);

				// 4. New traffic works.
				const fresh: Sent[] = [];
				for (let i = 0; i < 6; i++) {
					const entry: Sent = {
						wallet: wallet(i),
						operation: op("BET", "5.00"),
					};
					entry.reply = await submitOn(
						second.base,
						entry.wallet,
						entry.operation,
					);
					expect(entry.reply.status).toBe(201);
					fresh.push(entry);
				}

				// 5. Every distinct operation has exactly one effect.
				const all = [...answered, ...inFlight, ...fresh];
				for (const w of wallets) {
					const mine = all.filter((e) => e.wallet.id === w.id);
					const bets = await sql.query(
						"select external_transaction_id from wager_transactions where wallet_id = $1 and kind = 'BET'",
						[w.id],
					);
					expect(
						bets.rows.map((r) => r.external_transaction_id).sort(),
					).toEqual(mine.map((e) => e.operation.externalTransactionId).sort());
					expect(await walletBalance(sql, w.id)).toBe(
						(500 - 5 * mine.length).toFixed(2),
					);
				}
				await assertAllConsistent(
					p,
					wallets.map((w) => w.id),
				);
			});
		} finally {
			await sql.end();
		}
	}, 120_000);
});
