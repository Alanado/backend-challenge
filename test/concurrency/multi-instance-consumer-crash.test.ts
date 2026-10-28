import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { assertLedgerInvariant } from "../support/assertLedgerInvariant";
import { wagerMessage } from "../support/consumer-env";
import { newSqsClient } from "../support/event-consumer";
import { eventually } from "../support/eventually";
import { createWalletOn, walletBalance } from "../support/multi-instance";
import { createPersistence, type Persistence } from "../support/persistence";
import { Fleet } from "../support/spawnApp";
import { connect } from "../support/sql";
import { queueDepth, sendMessage } from "../support/sqs-poller";
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
	// Short visibility: the message of the dead instance is back within seconds.
	queues = await createSuiteQueues("c05", { visibilityTimeoutS: 3 });
	p = await createPersistence(db.url);
});

afterAll(async () => {
	await fleet.stopAll();
	await p.close();
	sqs.destroy();
	await queues.destroy();
	await db.drop();
});

describe("TST-C-05 an instance dies after the commit and before the ack (real processes, real PostgreSQL and SQS)", () => {
	test("TST-C-05 the process dies, the message comes back, another instance discards it through the inbox: one effect", async () => {
		const client = await connect(db.url);
		try {
			await fleet.withOutputOnFailure(async () => {
				const consumerOnly = {
					db,
					queues,
					roles: { outboxPublisher: false, pendingWorker: false },
				} as const;
				const doomed = await fleet.start(
					{ ...consumerOnly, fault: "crash-after-commit-before-ack" },
					"doomed",
				);
				const wallet = await createWalletOn(doomed.base, "100.00");
				const message = wagerMessage(wallet, { amount: "25.00" });
				await sendMessage(sqs, queues.main.url, message.body, wallet.id);

				// The process kills itself right after the commit: SIGKILL, no shutdown, no ack.
				const exit = await Promise.race([
					doomed.exited,
					new Promise<never>((_, reject) =>
						setTimeout(
							() => reject(new Error("the instance never died")),
							30_000,
						),
					),
				]);
				expect(exit).toEqual({ exitCode: null, signalCode: "SIGKILL" });

				// The effect is committed, the message was not acknowledged.
				expect(await walletBalance(client, wallet.id)).toBe("75.00");
				const inbox = await client.query(
					"select processed_at from inbox_messages where message_id = $1",
					[message.messageId],
				);
				expect(inbox.rowCount).toBe(1);
				expect(inbox.rows[0].processed_at).not.toBeNull();
				expect(await queueDepth(sqs, queues.main.url)).toBe(1);

				// Another instance, without the fault, receives the redelivery.
				const survivor = await fleet.start(
					{ ...consumerOnly, waitFor: "ready" },
					"survivor",
				);
				await eventually(
					async () => expect(await queueDepth(sqs, queues.main.url)).toBe(0),
					{ timeout: 30_000, interval: 200 },
				);

				// It was recognised and dropped (replay through the inbox), never applied again.
				expect(
					await survivor.metric("idempotent_requests_total", {
						outcome: "replay",
						channel: "sqs",
					}),
				).toBe(1);
				expect(
					await survivor.metric("wager_transactions_total", {
						kind: "BET",
						channel: "sqs",
					}),
				).toBe(0);

				// Exactly one effect.
				expect(await walletBalance(client, wallet.id)).toBe("75.00");
				const bets = await client.query(
					"select status from wager_transactions where wallet_id = $1 and kind = 'BET'",
					[wallet.id],
				);
				expect(bets.rows).toEqual([{ status: "PROCESSED" }]);
				const ledger = await client.query(
					"select count(*)::int as n from wallet_ledger_entries where wallet_id = $1",
					[wallet.id],
				);
				expect(ledger.rows[0].n).toBe(2); // opening + the bet
				expect(
					(
						await client.query(
							"select count(*)::int as n from inbox_messages where message_id = $1",
							[message.messageId],
						)
					).rows[0].n,
				).toBe(1);
				expect(await queueDepth(sqs, queues.dlq.url)).toBe(0);
				await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
			});
		} finally {
			await client.end();
		}
	}, 120_000);
});
