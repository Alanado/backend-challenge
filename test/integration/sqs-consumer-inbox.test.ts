import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { visibilityBackoffSeconds } from "../../src/modules/wagering/application/classify-message-error";
import { WagerTransactionKind } from "../../src/modules/wagering/domain/wager-transaction-kind";
import { WagerTransactionStatus } from "../../src/modules/wagering/domain/wager-transaction-status";
import { SimulatedCrashError } from "../../src/shared/fault-injector";
import { assertLedgerInvariant } from "../support/assertLedgerInvariant";
import {
	type ConsumerEnv,
	createConsumerEnv,
	inboxRows,
	wagerMessage,
	walletState,
} from "../support/consumer-env";
import { eventually } from "../support/eventually";
import { connect } from "../support/sql";
import { queueDepth } from "../support/sqs-poller";
import { bet, SUBMIT_CONTEXT } from "../support/submit-harness";

let env: ConsumerEnv;

beforeAll(async () => {
	env = await createConsumerEnv("inbox", { visibilityTimeoutS: 1 });
});

afterAll(async () => {
	await env.close();
});

const drained = () =>
	eventually(async () =>
		expect(await queueDepth(env.sqs, env.queues.main.url)).toBe(0),
	);

describe("TST-I-11 inbox and redelivery", () => {
	test("TST-I-11 the same message delivered twice has one effect", async () => {
		const wallet = await env.wallet("100.00");
		const message = wagerMessage(wallet, { amount: "30.00" });
		const rig = await env.rig();

		await env.send(message, wallet);
		await env.send(message, wallet); // a second delivery of the very same message
		rig.consumer.start();
		await drained();
		await rig.consumer.stop();

		const state = await walletState(env.sql, wallet.id);
		expect(state.balance).toBe("70.00");
		expect(state.ledgerEntries).toBe(2); // the OPENING credit and one debit
		expect(state.transactions.map((t) => t.status)).toEqual(["PROCESSED"]);
		const inbox = await inboxRows(env.sql, message.messageId);
		expect(inbox).toHaveLength(1);
		expect(inbox[0]?.consumer_name).toBe("wager-transactions-consumer");
		expect(inbox[0]?.processed_at).not.toBeNull();
		expect(rig.harness.metrics.processed).toHaveLength(1);
		expect(rig.harness.metrics.idempotent).toEqual([
			{ outcome: "replay", channel: "sqs" },
		]);
		await assertLedgerInvariant(env.p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-11 HTTP and SQS share the idempotency key: HTTP first, then SQS, is a replay", async () => {
		const wallet = await env.wallet("100.00");
		const rig = await env.rig();
		const command = bet(wallet.id, wallet.playerId, {
			money: { amount: "20.00", currency: "BRL" },
		});
		const first = await rig.harness.submit.execute(command, SUBMIT_CONTEXT);
		expect(first.idempotentReplay).toBe(false);

		await env.send(
			wagerMessage(wallet, {
				externalTransactionId: command.externalTransactionId,
				idempotencyKey: command.idempotencyKey,
				amount: "20.00",
			}),
			wallet,
		);
		rig.consumer.start();
		await drained();
		await rig.consumer.stop();

		const state = await walletState(env.sql, wallet.id);
		expect(state.balance).toBe("80.00");
		expect(state.transactions).toHaveLength(1);
		expect(rig.harness.metrics.idempotent).toEqual([
			{ outcome: "replay", channel: "sqs" },
		]);
		await assertLedgerInvariant(env.p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-11 SQS first, then HTTP with the same key and payload, is a replay", async () => {
		const wallet = await env.wallet("100.00");
		const rig = await env.rig();
		const message = wagerMessage(wallet, { amount: "20.00" });
		await env.send(message, wallet);
		rig.consumer.start();
		await drained();
		await rig.consumer.stop();

		const replay = await rig.harness.submit.execute(
			{
				providerId: "provider-a",
				externalTransactionId: message.externalTransactionId,
				idempotencyKey: message.idempotencyKey,
				playerId: wallet.playerId,
				walletId: wallet.id,
				roundId: "round-1",
				gameId: "game-1",
				kind: WagerTransactionKind.Bet,
				money: { amount: "20.00", currency: "BRL" },
			},
			SUBMIT_CONTEXT,
		);

		expect(replay.idempotentReplay).toBe(true);
		expect(replay.status).toBe(WagerTransactionStatus.Processed);
		expect((await walletState(env.sql, wallet.id)).balance).toBe("80.00");
		await assertLedgerInvariant(env.p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-11 the same key under another messageId is a replay: one debit", async () => {
		const wallet = await env.wallet("100.00");
		const rig = await env.rig();
		const external = `ext-${crypto.randomUUID()}`;
		const messageIds: string[] = [];
		for (let i = 0; i < 3; i++) {
			const message = wagerMessage(wallet, {
				externalTransactionId: external,
				amount: "10.00",
			});
			messageIds.push(message.messageId);
			await env.send(message, wallet);
		}
		rig.consumer.start();
		await drained();
		await rig.consumer.stop();

		const state = await walletState(env.sql, wallet.id);
		expect(state.balance).toBe("90.00");
		expect(rig.harness.metrics.processed).toHaveLength(1);
		expect(rig.harness.metrics.idempotent).toHaveLength(2);
		// Every message that was handled is closed in the inbox, replays included.
		for (const messageId of messageIds) {
			const rows = await inboxRows(env.sql, messageId);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.processed_at).not.toBeNull();
		}
	});

	test("TST-I-11 the same messageId with another body is permanent and has no effect", async () => {
		const wallet = await env.wallet("100.00");
		const rig = await env.rig();
		const original = wagerMessage(wallet, { amount: "10.00" });
		expect((await rig.handler.process(inbound(original.body))).kind).toBe(
			"ack",
		);

		const tampered = wagerMessage(wallet, {
			messageId: original.messageId,
			amount: "99.00",
		});
		const result = await rig.handler.process(inbound(tampered.body));

		expect(result).toMatchObject({
			kind: "permanent",
			errorCode: "INBOX_PAYLOAD_MISMATCH",
			reason: "inbox_payload_mismatch",
		});
		const state = await walletState(env.sql, wallet.id);
		expect(state.balance).toBe("90.00");
		expect(state.transactions).toHaveLength(1);
		expect(await inboxRows(env.sql, original.messageId)).toHaveLength(1);
		await assertLedgerInvariant(env.p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-11 business results are acked and leave the queue: REJECTED and PENDING_REFERENCE", async () => {
		const wallet = await env.wallet("10.00");
		const rig = await env.rig();
		await env.send(wagerMessage(wallet, { amount: "50.00" }), wallet); // INSUFFICIENT_FUNDS
		await env.send(
			wagerMessage(wallet, { kind: "REFUND", reference: "ext-not-yet" }),
			wallet,
		); // the reference does not exist yet

		rig.consumer.start();
		await drained();
		await rig.consumer.stop();

		const state = await walletState(env.sql, wallet.id);
		expect(state.balance).toBe("10.00");
		expect(state.transactions).toEqual([
			{ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" },
			{ status: "PENDING_REFERENCE", failure_code: null },
		]);
		expect(
			rig.commands.filter((c) => c.name === "DeleteMessageCommand"),
		).toHaveLength(2);
	});

	test("TST-I-11 a transient lock failure keeps the message, backs it off, and succeeds once the lock is free", async () => {
		const wallet = await env.wallet("100.00");
		// receiveCount of every delivery: a long poll abandoned by an earlier test's stop() can
		// still swallow this message once on the emulator, so the count is read, not assumed.
		const receiveCounts: number[] = [];
		const rig = await env.rig({
			persistence: { lockTimeoutMs: 200 },
			backoff: { baseS: 1, capS: 4 },
			wrap: (handler) => async (message) => {
				receiveCounts.push(message.receiveCount);
				return handler.handle(message);
			},
		});
		const message = wagerMessage(wallet, { amount: "10.00" });

		// A raw connection of its own holds the wallet row lock, as a slow concurrent transaction would.
		const holder = await connect(env.db.url);
		await holder.query("begin");
		await holder.query("select id from wallets where id = $1 for update", [
			wallet.id,
		]);
		let held = true;
		try {
			await env.send(message, wallet);
			rig.consumer.start();

			await eventually(() =>
				expect(
					rig.commands.some((c) => c.name === "ChangeMessageVisibilityCommand"),
				).toBe(true),
			);
			const change = rig.commands.find(
				(c) => c.name === "ChangeMessageVisibilityCommand",
			);
			expect(change?.input.VisibilityTimeout).toBe(
				visibilityBackoffSeconds(receiveCounts[0] ?? 1, 1, 4),
			);
			// Not acked, nothing applied, and the failure was counted as a lock conflict and a retry.
			expect(rig.commands.map((c) => c.name)).not.toContain(
				"DeleteMessageCommand",
			);
			expect((await walletState(env.sql, wallet.id)).balance).toBe("100.00");
			expect(rig.harness.metrics.lockConflicts).toContain("lock_timeout");
			expect(rig.harness.metrics.retries).toContain("consumer");

			await holder.query("rollback");
			held = false;
			await eventually(
				async () =>
					expect((await walletState(env.sql, wallet.id)).balance).toBe("90.00"),
				{ timeout: 10_000 },
			);
			await drained();
		} finally {
			if (held) await holder.query("rollback");
			await holder.end();
			await rig.consumer.stop();
		}
		await assertLedgerInvariant(env.p.ledgerIntegrity, wallet.id);
	}, 20_000);

	test("TST-I-11 the ack follows the commit: a crash between them redelivers, the inbox discards, one effect", async () => {
		const wallet = await env.wallet("100.00");
		let crashed = 0;
		const rig = await env.rig({
			crash: {
				point: "crash-after-commit-before-ack",
				fn: (point) => {
					crashed += 1;
					if (crashed === 1) throw new SimulatedCrashError(point);
				},
			},
		});
		const message = wagerMessage(wallet, { amount: "40.00" });
		await env.send(message, wallet);

		rig.consumer.start();
		// The effect is committed while the message is still in the queue.
		await eventually(async () => {
			expect((await walletState(env.sql, wallet.id)).balance).toBe("60.00");
		});
		await eventually(
			async () => {
				expect(crashed).toBeGreaterThanOrEqual(2);
				expect(await queueDepth(env.sqs, env.queues.main.url)).toBe(0);
			},
			{ timeout: 10_000 },
		);
		await rig.consumer.stop();

		const state = await walletState(env.sql, wallet.id);
		expect(state.balance).toBe("60.00");
		expect(state.ledgerEntries).toBe(2);
		expect(rig.harness.metrics.processed).toHaveLength(1);
		expect(rig.harness.metrics.idempotent).toEqual([
			{ outcome: "replay", channel: "sqs" },
		]);
		await assertLedgerInvariant(env.p.ledgerIntegrity, wallet.id);
	}, 20_000);
});

describe("X-LOCK-ORDER canonical lock order on the SQS channel (ADR-0007)", () => {
	test("X-LOCK-ORDER the inbox INSERT precedes the wallet FOR UPDATE, which precedes the wager_transactions INSERT", async () => {
		const wallet = await env.wallet("100.00");
		const queries: string[] = [];
		const rig = await env.rig({
			persistence: { onQuery: (statement) => queries.push(statement) },
		});

		const result = await rig.handler.process(
			inbound(wagerMessage(wallet, { amount: "10.00" }).body),
		);
		expect(result.kind).toBe("ack");

		const at = (pattern: RegExp) => queries.findIndex((q) => pattern.test(q));
		const inboxInsert = at(/insert into "?inbox_messages"?/i);
		const walletLock = at(/\bwallets\b.*\bfor update\b/is);
		const transactionInsert = at(/insert into "?wager_transactions"?/i);
		const inboxProcessed = at(/update "?inbox_messages"?/i);
		expect(inboxInsert).toBeGreaterThanOrEqual(0);
		expect(inboxInsert).toBeLessThan(walletLock);
		expect(walletLock).toBeLessThan(transactionInsert);
		expect(transactionInsert).toBeLessThan(inboxProcessed);
		// Before the wallet lock, wager_transactions is not touched at all on this channel.
		expect(
			queries.slice(0, walletLock).some((q) => /wager_transactions/i.test(q)),
		).toBe(false);
	});
});

function inbound(body: string) {
	return {
		id: `broker-${crypto.randomUUID()}`,
		body,
		receiveCount: 1,
		groupId: "g",
		deduplicationId: crypto.randomUUID(),
	};
}
