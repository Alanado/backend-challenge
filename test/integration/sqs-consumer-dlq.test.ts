import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { visibilityBackoffSeconds } from "../../src/modules/wagering/application/classify-message-error";
import { parseWagerTransactionMessage } from "../../src/modules/wagering/application/wager-transaction-message";
import { WagerTransactionStatus } from "../../src/modules/wagering/domain/wager-transaction-status";
import { loadConfig } from "../../src/shared/config";
import { assertLedgerInvariant } from "../support/assertLedgerInvariant";
import {
	type ConsumerEnv,
	createConsumerEnv,
	inboxRows,
	type TestWallet,
	wagerMessage,
	walletState,
} from "../support/consumer-env";
import { eventually } from "../support/eventually";
import { connect } from "../support/sql";
import { peekDeadLetters, queueDepth } from "../support/sqs-poller";
import { SUBMIT_CONTEXT } from "../support/submit-harness";

let env: ConsumerEnv;

beforeAll(async () => {
	env = await createConsumerEnv("dlq", { visibilityTimeoutS: 1 });
});

afterAll(async () => {
	await env.close();
});

/** Tests that wait out several one-second visibility timeouts. */
const LONG = 30_000;

const drained = () =>
	eventually(async () =>
		expect(await queueDepth(env.sqs, env.queues.main.url)).toBe(0),
	);

const deadLetterOf = (body: string) =>
	eventually(
		async () => {
			const found = (await peekDeadLetters(env.sqs, env.queues.dlq.url)).find(
				(d) => d.body === body,
			);
			if (found === undefined) throw new Error("not in the DLQ yet");
			return found;
		},
		{ timeout: 15_000 },
	);

/** A raw connection holding the wallet row lock, as a long concurrent transaction would. */
async function holdWalletLock(wallet: TestWallet) {
	const holder = await connect(env.db.url);
	await holder.query("begin");
	await holder.query("select id from wallets where id = $1 for update", [
		wallet.id,
	]);
	let open = true;
	return {
		async release() {
			if (!open) return;
			open = false;
			await holder.query("rollback");
			await holder.end();
		},
	};
}

describe("TST-I-12 configuration", () => {
	test("TST-I-12 SQS_MAX_RECEIVE defaults to 8, as does the redrive threshold of the queue", async () => {
		expect(loadConfig({ DATABASE_URL: "postgres://x" }).sqs.maxReceive).toBe(8);
		const attrs = await env.sqs.send(
			new GetQueueAttributesCommand({
				QueueUrl: env.queues.main.url,
				AttributeNames: ["RedrivePolicy"],
			}),
		);
		expect(JSON.parse(attrs.Attributes?.RedrivePolicy ?? "{}")).toMatchObject({
			maxReceiveCount: 8,
		});
	});
});

describe("TST-I-12 transient failures: backoff and the rest of the group", () => {
	test(
		"TST-I-12 a transient failure hides the message for a growing visibility, then it succeeds",
		async () => {
			const wallet = await env.wallet("100.00");
			const receiveCounts: number[] = [];
			const rig = await env.rig({
				persistence: { lockTimeoutMs: 150 },
				backoff: { baseS: 1, capS: 4 },
				wrap: (handler) => async (message) => {
					receiveCounts.push(message.receiveCount);
					return handler.handle(message);
				},
			});
			const lock = await holdWalletLock(wallet);
			try {
				await env.send(wagerMessage(wallet, { amount: "10.00" }), wallet);
				rig.consumer.start();

				const hidden = () =>
					rig.commands
						.filter((c) => c.name === "ChangeMessageVisibilityCommand")
						.map((c) => Number(c.input.VisibilityTimeout))
						.filter((seconds) => seconds > 0);
				await eventually(
					() => expect(hidden().length).toBeGreaterThanOrEqual(3),
					{
						timeout: 15_000,
					},
				);

				const delays = hidden().slice(0, 3);
				expect(delays).toEqual(
					receiveCounts
						.slice(0, 3)
						.map((n) => visibilityBackoffSeconds(n, 1, 4)),
				);
				expect(delays[1]).toBeGreaterThan(delays[0] ?? 0);
				expect(rig.harness.metrics.retries.length).toBeGreaterThanOrEqual(3);
				expect(rig.harness.metrics.dlq).toEqual([]);
			} finally {
				await lock.release();
			}
			await eventually(
				async () =>
					expect((await walletState(env.sql, wallet.id)).balance).toBe("90.00"),
				{ timeout: 15_000 },
			);
			await drained();
			await rig.consumer.stop();
			await assertLedgerInvariant(env.p.ledgerIntegrity, wallet.id);
		},
		LONG,
	);

	test(
		"TST-I-12 a transient failure hands the rest of the group back unprocessed",
		async () => {
			const locked = await env.wallet("100.00");
			const free = await env.wallet("100.00");
			const first = wagerMessage(locked, { amount: "10.00" });
			const second = wagerMessage(free, { amount: "10.00" });
			const calls: Array<{ id: string; receiveCount: number }> = [];
			const rig = await env.rig({
				persistence: { lockTimeoutMs: 150 },
				wrap: (handler) => async (message) => {
					calls.push({
						id: parseWagerTransactionMessage(message.body).messageId,
						receiveCount: message.receiveCount,
					});
					return handler.handle(message);
				},
			});
			const lock = await holdWalletLock(locked);
			const group = `shared-${crypto.randomUUID()}`; // two wallets in one group: only the group links them
			try {
				await env.send(first, locked, group);
				await env.send(second, free, group);
				rig.consumer.start();
				await eventually(() =>
					expect(calls.some((c) => c.id === first.messageId)).toBe(true),
				);
				await eventually(() =>
					expect(
						rig.commands.some(
							(c) => c.name === "ChangeMessageVisibilityCommand",
						),
					).toBe(true),
				);
				// The second message was received in the first message's batch but never handled there.
				const handledBeforeRelease = calls.filter(
					(c) => c.id === second.messageId,
				);
				expect(handledBeforeRelease.every((c) => c.receiveCount >= 2)).toBe(
					true,
				);
			} finally {
				await lock.release();
			}
			await eventually(
				async () => {
					expect((await walletState(env.sql, locked.id)).balance).toBe("90.00");
					expect((await walletState(env.sql, free.id)).balance).toBe("90.00");
				},
				{ timeout: 15_000 },
			);
			await drained();
			await rig.consumer.stop();
		},
		LONG,
	);
});

describe("TST-I-12 permanent failures go to the DLQ at once", () => {
	test.each([
		{
			name: "invalid JSON",
			build: () => "{this is not json",
			errorCode: "INVALID_JSON",
			reason: "invalid_json",
		},
		{
			name: "an unknown type",
			build: (w: TestWallet) =>
				JSON.stringify({
					...JSON.parse(wagerMessage(w).body),
					type: "SomethingElse",
				}),
			errorCode: "UNKNOWN_MESSAGE_TYPE",
			reason: "unknown_type",
		},
		{
			name: "an invalid schema",
			build: (w: TestWallet) => wagerMessage(w, { amount: "12.5" }).body,
			errorCode: "VALIDATION_ERROR",
			reason: "invalid_schema",
		},
		{
			name: "kind OPENING",
			build: (w: TestWallet) => wagerMessage(w, { kind: "OPENING" }).body,
			errorCode: "VALIDATION_ERROR",
			reason: "opening_not_allowed",
		},
		{
			name: "a wallet that does not exist (P-7)",
			build: () =>
				wagerMessage({ id: crypto.randomUUID(), playerId: crypto.randomUUID() })
					.body,
			errorCode: "WALLET_NOT_FOUND",
			reason: "wallet_not_found",
		},
	])(
		"TST-I-12 $name is dead-lettered on the first delivery",
		async (c) => {
			const wallet = await env.wallet("100.00");
			const body = c.build(wallet);
			const handled: number[] = [];
			const rig = await env.rig({
				wrap: (handler) => async (message) => {
					handled.push(message.receiveCount);
					return handler.handle(message);
				},
			});
			const group = `perm-${crypto.randomUUID()}`;
			await (await import("../support/sqs-poller")).sendMessage(
				env.sqs,
				env.queues.main.url,
				body,
				group,
				`dedup-${crypto.randomUUID()}`,
			);

			rig.consumer.start();
			const dead = await deadLetterOf(body);
			await drained();
			await rig.consumer.stop();

			expect(dead.errorCode).toBe(c.errorCode);
			expect(dead.reason).toBe(c.reason);
			expect(dead.groupId).toBe(group);
			expect(dead.deduplicationId).toMatch(/^dedup-/);
			expect(rig.harness.metrics.dlq).toEqual([c.reason]);
			// Handled once: a permanent failure is not retried.
			expect(handled).toHaveLength(1);
			expect((await walletState(env.sql, wallet.id)).balance).toBe("100.00");
		},
		LONG,
	);

	test(
		"TST-I-12 the same messageId with another body goes to the DLQ and has no effect",
		async () => {
			const wallet = await env.wallet("100.00");
			const rig = await env.rig();
			const original = wagerMessage(wallet, { amount: "10.00" });
			const tampered = wagerMessage(wallet, {
				messageId: original.messageId,
				amount: "99.00",
			});

			await env.send(original, wallet);
			rig.consumer.start();
			await eventually(async () =>
				expect((await walletState(env.sql, wallet.id)).balance).toBe("90.00"),
			);
			await env.send(tampered, wallet);
			const dead = await deadLetterOf(tampered.body);
			await drained();
			await rig.consumer.stop();

			expect(dead.errorCode).toBe("INBOX_PAYLOAD_MISMATCH");
			expect((await walletState(env.sql, wallet.id)).balance).toBe("90.00");
			await assertLedgerInvariant(env.p.ledgerIntegrity, wallet.id);
		},
		LONG,
	);

	test(
		"TST-I-12 a permanent failure does not block the next message of its group",
		async () => {
			const wallet = await env.wallet("100.00");
			const poison = wagerMessage(
				{ id: crypto.randomUUID(), playerId: crypto.randomUUID() },
				{ amount: "10.00" },
			);
			const good = wagerMessage(wallet, { amount: "10.00" });
			const bodies: string[] = [];
			const rig = await env.rig({
				wrap: (handler) => async (message) => {
					bodies.push(message.body);
					return handler.handle(message);
				},
			});
			const group = `head-${crypto.randomUUID()}`;
			await env.send(poison, wallet, group);
			await env.send(good, wallet, group);

			rig.consumer.start();
			await eventually(async () =>
				expect((await walletState(env.sql, wallet.id)).balance).toBe("90.00"),
			);
			await drained();
			await rig.consumer.stop();

			expect(bodies).toEqual([poison.body, good.body]); // each handled exactly once, in order
			expect((await deadLetterOf(poison.body)).errorCode).toBe(
				"WALLET_NOT_FOUND",
			);
			await assertLedgerInvariant(env.p.ledgerIntegrity, wallet.id);
		},
		LONG,
	);
});

describe("TST-I-12 exhaustion", () => {
	test(
		"TST-I-12 a message that keeps failing is recorded FAILED, evented, dead-lettered and removed on the last delivery",
		async () => {
			const wallet = await env.wallet("100.00");
			const message = wagerMessage(wallet, { amount: "25.00" });
			const receiveCounts: number[] = [];
			// `fail-mid-transaction` makes every normal attempt roll back; the FAILED record is a
			// separate transaction and is not affected.
			const rig = await env.rig({
				useCaseFault: "fail-mid-transaction",
				maxReceive: 3,
				backoff: { baseS: 1, capS: 1 },
				wrap: (handler) => async (m) => {
					receiveCounts.push(m.receiveCount);
					return handler.handle(m);
				},
			});

			await env.send(message, wallet);
			rig.consumer.start();
			const dead = await deadLetterOf(message.body);
			await drained();
			await rig.consumer.stop();

			expect(dead.errorCode).toBe("PROCESSING_ATTEMPTS_EXHAUSTED");
			expect(dead.reason).toBe("attempts_exhausted");
			expect(Math.max(...receiveCounts)).toBe(3);
			expect(receiveCounts.at(-1)).toBe(3);

			const state = await walletState(env.sql, wallet.id);
			expect(state.balance).toBe("100.00");
			expect(state.transactions).toEqual([
				{ status: "FAILED", failure_code: "PROCESSING_ATTEMPTS_EXHAUSTED" },
			]);
			const events = await env.sql.query(
				`select o.event_type from outbox_messages o
			   join wager_transactions t on t.id::text = o.aggregate_id
			  where t.wallet_id = $1 and t.kind <> 'OPENING'`,
				[wallet.id],
			);
			expect(events.rows).toEqual([{ event_type: "WagerTransactionFailed" }]);
			expect(rig.harness.metrics.dlq).toEqual(["attempts_exhausted"]);
			expect(rig.harness.metrics.retries.length).toBe(receiveCounts.length - 1);

			// FAILED is definitive: a replay, from any channel, answers FAILED.
			const replay = await rig.harness.submit.execute(
				parseWagerTransactionMessage(message.body).command,
				SUBMIT_CONTEXT,
			);
			expect(replay.status).toBe(WagerTransactionStatus.Failed);
			expect(replay.idempotentReplay).toBe(true);
			await assertLedgerInvariant(env.p.ledgerIntegrity, wallet.id);
		},
		LONG,
	);

	test(
		"TST-I-12 with the wallet lock held to the end there is no FAILED to write, but the message still leaves for the DLQ",
		async () => {
			const wallet = await env.wallet("100.00");
			const message = wagerMessage(wallet, { amount: "25.00" });
			const rig = await env.rig({
				persistence: { lockTimeoutMs: 150 },
				maxReceive: 2,
				backoff: { baseS: 1, capS: 1 },
			});
			const lock = await holdWalletLock(wallet);
			try {
				await env.send(message, wallet);
				rig.consumer.start();
				const dead = await deadLetterOf(message.body);
				expect(dead.errorCode).toBe("PROCESSING_ATTEMPTS_EXHAUSTED");
				await drained();
			} finally {
				await lock.release();
			}
			await rig.consumer.stop();

			// The FAILED record needs the very lock that was held: without a database that answers, the
			// DLQ is the record (03-messaging §3.3).
			const state = await walletState(env.sql, wallet.id);
			expect(state.balance).toBe("100.00");
			expect(state.transactions).toEqual([]);
			expect(await inboxRows(env.sql, message.messageId)).toEqual([]);
		},
		LONG,
	);

	test("TST-I-12 a message already handled by an earlier attempt is not marked FAILED", async () => {
		const wallet = await env.wallet("100.00");
		const rig = await env.rig();
		const message = wagerMessage(wallet, { amount: "10.00" });
		const { command, bodyHash } = parseWagerTransactionMessage(message.body);
		const delivery = {
			id: "broker-1",
			body: message.body,
			receiveCount: 1,
			groupId: wallet.id,
			deduplicationId: "d",
		};
		expect((await rig.handler.process(delivery)).kind).toBe("ack");

		// Same messageId: the inbox says it is done. Another messageId, same key: the transaction exists.
		expect(
			await rig.exhausted.execute(command, {
				messageId: message.messageId,
				messageHash: bodyHash,
			}),
		).toBe("already-handled");
		expect(
			await rig.exhausted.execute(command, {
				messageId: `other-${crypto.randomUUID()}`,
				messageHash: "irrelevant",
			}),
		).toBe("already-handled");

		const state = await walletState(env.sql, wallet.id);
		expect(state.transactions).toEqual([
			{ status: "PROCESSED", failure_code: null },
		]);
		expect(state.balance).toBe("90.00");
	});
});
