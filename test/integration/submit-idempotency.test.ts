import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import {
	ExternalTransactionIdConflictError,
	IdempotencyKeyPayloadMismatchError,
} from "../../src/modules/wagering/application/errors";
import type { SubmitWagerTransactionCommand } from "../../src/modules/wagering/application/submit-wager-transaction";
import { FailureCode } from "../../src/modules/wagering/domain/failure-code";
import { payloadHash } from "../../src/modules/wagering/domain/payload-hash";
import { WagerTransactionKind } from "../../src/modules/wagering/domain/wager-transaction-kind";
import { WagerTransactionStatus } from "../../src/modules/wagering/domain/wager-transaction-status";
import { Money } from "../../src/shared/money";
import { assertLedgerInvariant } from "../support/assertLedgerInvariant";
import { openWalletWithOpening } from "../support/domain-builders";
import { eventually } from "../support/eventually";
import { uniqueId } from "../support/ids";
import { createPersistence, type Persistence } from "../support/persistence";
import { connect, insertTransaction } from "../support/sql";
import {
	bet,
	createSubmitHarness,
	SUBMIT_CONTEXT,
	type SubmitHarness,
} from "../support/submit-harness";
import {
	createSuiteDatabase,
	type SuiteDatabase,
} from "../support/suite-database";

let db: SuiteDatabase;
let sql: Client;
let p: Persistence;
let h: SubmitHarness;
const queries: string[] = [];

beforeAll(async () => {
	db = await createSuiteDatabase();
	sql = await connect(db.url);
	p = await createPersistence(db.url, { onQuery: (q) => queries.push(q) });
	h = createSubmitHarness(p);
});

afterAll(async () => {
	await p.close();
	await sql.end();
	await db.drop();
});

type Row = Record<string, unknown>;
const rows = async (text: string, params: unknown[]): Promise<Row[]> =>
	(await sql.query(text, params)).rows as Row[];

const walletRow = async (id: string) =>
	(await rows("select balance, version from wallets where id = $1", [id]))[0];
const ledgerCount = async (walletId: string) =>
	(
		await rows("select 1 from wallet_ledger_entries where wallet_id = $1", [
			walletId,
		])
	).length;
const outboxCount = async (walletId: string) =>
	(await rows("select 1 from outbox_messages where group_key = $1", [walletId]))
		.length;
const transactionCount = async (walletId: string) =>
	(
		await rows("select 1 from wager_transactions where wallet_id = $1", [
			walletId,
		])
	).length;

/** Everything a rejected or replayed call must leave exactly as it was. */
const snapshotOf = async (walletId: string) => ({
	wallet: await walletRow(walletId),
	ledger: await ledgerCount(walletId),
	outbox: await outboxCount(walletId),
	transactions: await transactionCount(walletId),
});

const hashOf = (c: SubmitWagerTransactionCommand) =>
	payloadHash({ ...c, money: Money.from(c.money) });

describe("TST-I-07 idempotency (use case, real PostgreSQL)", () => {
	test("TST-I-07 the replay returns the balance OBSERVED at the time, not the current one", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const first = bet(wallet.id, wallet.playerId); // BET 25.00
		const original = await h.submit.execute(first, SUBMIT_CONTEXT);
		await h.submit.execute(
			bet(wallet.id, wallet.playerId, {
				money: { amount: "10.00", currency: "BRL" },
			}),
			SUBMIT_CONTEXT,
		);
		expect((await walletRow(wallet.id))?.balance).toBe("65.00");
		const before = await snapshotOf(wallet.id);

		const replay = await h.submit.execute(first, SUBMIT_CONTEXT);

		expect(original.balance).toEqual({ amount: "75.00", currency: "BRL" });
		expect(replay).toEqual({
			transactionId: original.transactionId,
			status: WagerTransactionStatus.Processed,
			balance: { amount: "75.00", currency: "BRL" },
			failureCode: null,
			idempotentReplay: true,
		});
		expect(await snapshotOf(wallet.id)).toEqual(before);
		expect(h.metrics.idempotent.at(-1)).toEqual({
			outcome: "replay",
			channel: "http",
		});
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-07 a replay is answered by the fast path: no wallet lock, no INSERT", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const command = bet(wallet.id, wallet.playerId);
		await h.submit.execute(command, SUBMIT_CONTEXT);
		queries.length = 0;

		await h.submit.execute(command, SUBMIT_CONTEXT);

		expect(queries.filter((q) => /for update/i.test(q))).toEqual([]);
		expect(queries.filter((q) => /insert into/i.test(q))).toEqual([]);
		expect(queries.some((q) => /wager_transactions/i.test(q))).toBe(true);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-07 a replay of a REJECTED transaction repeats its failureCode and observed balance", async () => {
		const wallet = await openWalletWithOpening(p, "10.00");
		const command = bet(wallet.id, wallet.playerId);
		const original = await h.submit.execute(command, SUBMIT_CONTEXT);
		const before = await snapshotOf(wallet.id);

		const replay = await h.submit.execute(command, SUBMIT_CONTEXT);

		expect(original.failureCode).toBe(FailureCode.InsufficientFunds);
		expect(replay).toEqual({ ...original, idempotentReplay: true });
		expect(replay.balance).toEqual({ amount: "10.00", currency: "BRL" });
		expect(await snapshotOf(wallet.id)).toEqual(before);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-07 a replay of a LOSS emits no event and keeps the version", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const command = bet(wallet.id, wallet.playerId, {
			kind: WagerTransactionKind.Loss,
		});
		await h.submit.execute(command, SUBMIT_CONTEXT);
		const before = await snapshotOf(wallet.id);

		const replay = await h.submit.execute(command, SUBMIT_CONTEXT);

		expect(replay.idempotentReplay).toBe(true);
		expect(await snapshotOf(wallet.id)).toEqual(before);
		expect(before.wallet).toEqual({ balance: "100.00", version: 1 });
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	// One case per business field of the hash (04-api §6): ignoring any of them would let a different payload through.
	const variations: Array<
		[
			string,
			(wallet: {
				id: string;
				playerId: string;
			}) => Partial<SubmitWagerTransactionCommand>,
		]
	> = [
		["money.amount", () => ({ money: { amount: "26.00", currency: "BRL" } })],
		["money.currency", () => ({ money: { amount: "25.00", currency: "USD" } })],
		["kind", () => ({ kind: WagerTransactionKind.Loss })],
		["roundId", () => ({ roundId: "round-2" })],
		["gameId", () => ({ gameId: "game-2" })],
		["playerId", () => ({ playerId: uniqueId() })],
		["walletId", () => ({ walletId: uniqueId() })],
		[
			"externalTransactionId",
			() => ({ externalTransactionId: `other-${uniqueId()}` }),
		],
		[
			"referenceExternalTransactionId",
			() => ({ referenceExternalTransactionId: "some-ref" }),
		],
	];

	for (const [field, change] of variations) {
		test(`TST-I-07 the same key with a different ${field} is a payload mismatch and changes nothing`, async () => {
			const wallet = await openWalletWithOpening(p, "100.00");
			// a WIN so that `referenceExternalTransactionId` and `kind` are valid variations
			const original = bet(wallet.id, wallet.playerId, {
				kind: WagerTransactionKind.Win,
			});
			await h.submit.execute(original, SUBMIT_CONTEXT);
			const before = await snapshotOf(wallet.id);

			await expect(
				h.submit.execute({ ...original, ...change(wallet) }, SUBMIT_CONTEXT),
			).rejects.toBeInstanceOf(IdempotencyKeyPayloadMismatchError);

			expect(await snapshotOf(wallet.id)).toEqual(before);
			expect(h.metrics.idempotent.at(-1)).toEqual({
				outcome: "conflict",
				channel: "http",
			});
			await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
		});
	}

	test("TST-I-07 the same external transaction id under another key is EXTERNAL_TRANSACTION_ID_CONFLICT and changes nothing", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const original = bet(wallet.id, wallet.playerId);
		await h.submit.execute(original, SUBMIT_CONTEXT);
		const before = await snapshotOf(wallet.id);

		const error = await h.submit
			.execute(
				{ ...original, idempotencyKey: `another-${uniqueId()}` },
				SUBMIT_CONTEXT,
			)
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ExternalTransactionIdConflictError);
		expect(await snapshotOf(wallet.id)).toEqual(before);
		expect(h.metrics.idempotent.at(-1)).toEqual({
			outcome: "conflict",
			channel: "http",
		});
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-07 the same external id with another key AND another payload is still an external id conflict", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const original = bet(wallet.id, wallet.playerId);
		await h.submit.execute(original, SUBMIT_CONTEXT);

		await expect(
			h.submit.execute(
				{
					...original,
					idempotencyKey: `another-${uniqueId()}`,
					money: { amount: "1.00", currency: "BRL" },
				},
				SUBMIT_CONTEXT,
			),
		).rejects.toBeInstanceOf(ExternalTransactionIdConflictError);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-07 the same key under another provider is a different operation, not a replay", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const original = bet(wallet.id, wallet.playerId);
		await h.submit.execute(original, SUBMIT_CONTEXT);

		const other = await h.submit.execute(
			{ ...original, providerId: "provider-b" },
			SUBMIT_CONTEXT,
		);

		expect(other.idempotentReplay).toBe(false);
		expect(other.balance).toEqual({ amount: "50.00", currency: "BRL" });
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-07 the replay follows the CURRENT state (PENDING_REFERENCE that became PROCESSED answers PROCESSED)", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const command = bet(wallet.id, wallet.playerId, {
			kind: WagerTransactionKind.Win,
			referenceExternalTransactionId: "bet-that-arrives-later",
		});
		const stored = await insertTransaction(sql, wallet.id, {
			provider_id: command.providerId,
			external_transaction_id: command.externalTransactionId,
			idempotency_key: command.idempotencyKey,
			payload_hash: hashOf(command),
			player_id: wallet.playerId,
			kind: command.kind,
			reference_external_transaction_id: command.referenceExternalTransactionId,
			status: "PENDING_REFERENCE",
			next_attempt_at: new Date(Date.now() + 60_000),
			observed_balance: "100.00",
		});
		const whilePending = await h.submit.execute(command, SUBMIT_CONTEXT);
		await sql.query(
			"update wager_transactions set status = 'PROCESSED', processed_at = now(), observed_balance = '125.00', next_attempt_at = null where id = $1",
			[stored.id],
		);
		const afterProcessed = await h.submit.execute(command, SUBMIT_CONTEXT);

		expect(whilePending).toEqual({
			transactionId: stored.id as string,
			status: WagerTransactionStatus.PendingReference,
			balance: { amount: "100.00", currency: "BRL" },
			failureCode: null,
			idempotentReplay: true,
		});
		expect(afterProcessed).toEqual({
			transactionId: stored.id as string,
			status: WagerTransactionStatus.Processed,
			balance: { amount: "125.00", currency: "BRL" },
			failureCode: null,
			idempotentReplay: true,
		});
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-07 a FAILED transaction replays with balance null", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const command = bet(wallet.id, wallet.playerId);
		await insertTransaction(sql, wallet.id, {
			provider_id: command.providerId,
			external_transaction_id: command.externalTransactionId,
			idempotency_key: command.idempotencyKey,
			payload_hash: hashOf(command),
			player_id: wallet.playerId,
			status: "FAILED",
			failure_code: "PROCESSING_ATTEMPTS_EXHAUSTED",
		});

		const replay = await h.submit.execute(command, SUBMIT_CONTEXT);

		expect(replay).toMatchObject({
			status: WagerTransactionStatus.Failed,
			balance: null,
			failureCode: FailureCode.ProcessingAttemptsExhausted,
			idempotentReplay: true,
		});
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-07 the deduplication is in the database: a brand new use case and pool still replays", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const command = bet(wallet.id, wallet.playerId);
		const original = await h.submit.execute(command, SUBMIT_CONTEXT);

		const restarted = await createPersistence(db.url);
		try {
			const fresh = createSubmitHarness(restarted);
			const replay = await fresh.submit.execute(command, SUBMIT_CONTEXT);

			expect(replay).toEqual({ ...original, idempotentReplay: true });
			expect(await ledgerCount(wallet.id)).toBe(2);
		} finally {
			await restarted.close();
		}
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-07 smoke: 10 identical calls in parallel produce 1 original, 9 replays and one debit", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const command = bet(wallet.id, wallet.playerId);
		const wide = await createPersistence(db.url, { poolMax: 14 });
		try {
			const harness = createSubmitHarness(wide);

			const results = await Promise.all(
				Array.from({ length: 10 }, () =>
					harness.submit.execute(command, SUBMIT_CONTEXT),
				),
			);

			expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
			expect(results.filter((r) => r.idempotentReplay)).toHaveLength(9);
			expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
			expect(new Set(results.map((r) => r.balance?.amount))).toEqual(
				new Set(["75.00"]),
			);
		} finally {
			await wide.close();
		}
		expect(await walletRow(wallet.id)).toEqual({
			balance: "75.00",
			version: 2,
		});
		expect(await ledgerCount(wallet.id)).toBe(2); // OPENING + one DEBIT
		expect(await transactionCount(wallet.id)).toBe(2); // OPENING + the BET
		expect(await outboxCount(wallet.id)).toBe(2); // Processed + WalletBalanceChanged, once
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});
});

/**
 * The race the fast path cannot see: the call passes the fast path (nothing stored yet), blocks
 * on the wallet lock, and meanwhile the "winner" commits its row. Deterministic: a second
 * connection holds the lock, `seed` plays the winner, then the lock is released.
 */
async function raceAgainstWinner(
	walletId: string,
	command: SubmitWagerTransactionCommand,
	seed: (holder: Client) => Promise<void>,
) {
	const holder = await connect(db.url);
	try {
		await holder.query("begin");
		await holder.query("select 1 from wallets where id = $1 for update", [
			walletId,
		]);
		const outcome = h.submit.execute(command, SUBMIT_CONTEXT).then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
		await eventually(async () => {
			const waiting = await rows(
				"select 1 from pg_stat_activity where datname = $1 and wait_event_type = 'Lock'",
				[db.name],
			);
			return waiting.length > 0;
		});
		await seed(holder);
		await holder.query("commit");
		return await outcome;
	} finally {
		await holder.end();
	}
}

describe("TST-I-07 re-read after ON CONFLICT DO NOTHING (inside the transaction, after the lock)", () => {
	const winnerRow = (
		command: SubmitWagerTransactionCommand,
		overrides: Row = {},
	): Row => ({
		provider_id: command.providerId,
		external_transaction_id: command.externalTransactionId,
		idempotency_key: command.idempotencyKey,
		payload_hash: hashOf(command),
		player_id: command.playerId,
		status: "PROCESSED",
		processed_at: new Date(),
		observed_balance: "75.00",
		...overrides,
	});

	test("TST-I-07 same key and same payload committed meanwhile: the call becomes a replay", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const command = bet(wallet.id, wallet.playerId);

		const outcome = await raceAgainstWinner(
			wallet.id,
			command,
			async (holder) => {
				await insertTransaction(holder, wallet.id, winnerRow(command));
			},
		);

		expect(outcome).toEqual({
			value: expect.objectContaining({
				status: WagerTransactionStatus.Processed,
				balance: { amount: "75.00", currency: "BRL" },
				idempotentReplay: true,
			}),
		});
		expect(await walletRow(wallet.id)).toEqual({
			balance: "100.00",
			version: 1,
		});
		expect(await ledgerCount(wallet.id)).toBe(1);
		expect(await outboxCount(wallet.id)).toBe(0);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-07 same key and another payload committed meanwhile: payload mismatch", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const command = bet(wallet.id, wallet.playerId);

		const outcome = await raceAgainstWinner(
			wallet.id,
			command,
			async (holder) => {
				await insertTransaction(
					holder,
					wallet.id,
					winnerRow(command, { payload_hash: "a-different-payload" }),
				);
			},
		);

		expect(outcome).toEqual({
			error: expect.any(IdempotencyKeyPayloadMismatchError),
		});
		expect(await walletRow(wallet.id)).toEqual({
			balance: "100.00",
			version: 1,
		});
		expect(await ledgerCount(wallet.id)).toBe(1);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-07 only the external id committed meanwhile (other key): external id conflict", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const command = bet(wallet.id, wallet.playerId);

		const outcome = await raceAgainstWinner(
			wallet.id,
			command,
			async (holder) => {
				await insertTransaction(
					holder,
					wallet.id,
					winnerRow(command, { idempotency_key: `other-${uniqueId()}` }),
				);
			},
		);

		expect(outcome).toEqual({
			error: expect.any(ExternalTransactionIdConflictError),
		});
		expect(await walletRow(wallet.id)).toEqual({
			balance: "100.00",
			version: 1,
		});
		expect(await ledgerCount(wallet.id)).toBe(1);
		expect(h.metrics.idempotent.at(-1)).toEqual({
			outcome: "conflict",
			channel: "http",
		});
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});
});
