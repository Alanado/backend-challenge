import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { assertLedgerInvariant } from "../support/assertLedgerInvariant";
import { deadlocksOf } from "../support/concurrency";
import {
	type ConsumerEnv,
	createConsumerEnv,
	wagerMessage,
	walletState,
} from "../support/consumer-env";
import { eventually } from "../support/eventually";
import { queueDepth } from "../support/sqs-poller";

let env: ConsumerEnv;

beforeAll(async () => {
	env = await createConsumerEnv("c01sqs", { visibilityTimeoutS: 30 });
});

afterAll(async () => {
	const deadlocks = await deadlocksOf(env.sql);
	await env.close();
	expect(deadlocks).toBe(0);
});

describe("TST-C-01 (SQS half) the same BET 50 times, two consumer instances in parallel", () => {
	test("TST-C-01 one debit: 25 messageIds with one key, 5 of them repeated five times, 2 consumers", async () => {
		const wallet = await env.wallet("100.00");
		const external = `ext-${crypto.randomUUID()}`;
		const original = (messageId: string) =>
			wagerMessage(wallet, {
				messageId,
				externalTransactionId: external,
				amount: "30.00",
			});
		const distinct = Array.from(
			{ length: 25 },
			(_, i) => `c01-${i}-${crypto.randomUUID()}`,
		);
		// 25 distinct messageIds + the first five delivered four more times each (= 20) + five more repeats.
		const ids = [
			...distinct,
			...distinct.slice(0, 5),
			...distinct.slice(0, 5),
			...distinct.slice(0, 5),
			...distinct.slice(0, 5),
			...distinct.slice(0, 5),
		];
		expect(ids).toHaveLength(50);

		// One group per message: FIFO would otherwise serialise the group and hide the contention.
		// The correctness never depends on the grouping (03-messaging §1).
		await Promise.all(
			ids.map((id) =>
				env.send(original(id), wallet, `group-${crypto.randomUUID()}`),
			),
		);
		const [a, b] = await Promise.all([env.rig(), env.rig()]);
		a.consumer.start();
		b.consumer.start();
		await eventually(
			async () =>
				expect(await queueDepth(env.sqs, env.queues.main.url)).toBe(0),
			{ timeout: 30_000 },
		);
		await Promise.all([a.consumer.stop(), b.consumer.stop()]);

		const state = await walletState(env.sql, wallet.id);
		expect(state.balance).toBe("70.00");
		expect(state.ledgerEntries).toBe(2); // OPENING + one debit
		expect(state.transactions).toEqual([
			{ status: "PROCESSED", failure_code: null },
		]);
		const inbox = await env.sql.query(
			"select count(*)::int as n, count(processed_at)::int as done from inbox_messages where message_id like 'c01-%'",
		);
		expect(inbox.rows[0]).toEqual({ n: 25, done: 25 });
		const processed =
			a.harness.metrics.processed.length + b.harness.metrics.processed.length;
		const replays = [
			...a.harness.metrics.idempotent,
			...b.harness.metrics.idempotent,
		].filter((m) => m.outcome === "replay").length;
		expect(processed).toBe(1);
		expect(replays).toBe(49);
		await assertLedgerInvariant(env.p.ledgerIntegrity, wallet.id);
	});
});
