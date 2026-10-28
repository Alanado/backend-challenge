import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import type {
	SubmitWagerTransactionCommand,
	WagerTransactionResult,
} from "../../src/modules/wagering/application/submit-wager-transaction";
import { FailureCode } from "../../src/modules/wagering/domain/failure-code";
import { WagerTransactionKind as Kind } from "../../src/modules/wagering/domain/wager-transaction-kind";
import { WagerTransactionStatus as Status } from "../../src/modules/wagering/domain/wager-transaction-status";
import type { Wallet } from "../../src/modules/wallet/domain/wallet";
import { assertLedgerInvariant } from "../support/assertLedgerInvariant";
import { openWalletWithOpening } from "../support/domain-builders";
import { uniqueId } from "../support/ids";
import { createPersistence, type Persistence } from "../support/persistence";
import { connect, insertTransaction, insertWallet } from "../support/sql";
import {
	bet,
	createSubmitHarness,
	FIRST_PENDING_DELAY_MS,
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

beforeAll(async () => {
	db = await createSuiteDatabase();
	sql = await connect(db.url);
	p = await createPersistence(db.url);
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
const ledgerOf = (walletId: string) =>
	rows(
		"select direction, amount, wallet_version, balance_after from wallet_ledger_entries where wallet_id = $1 order by wallet_version",
		[walletId],
	);
const txRow = async (id: string): Promise<Row> =>
	(
		await rows("select * from wager_transactions where id = $1", [id])
	)[0] as Row;
const eventTypes = async (transactionId: string) =>
	(
		await rows(
			"select event_type from outbox_messages where payload->'data'->>'transactionId' = $1 order by event_type",
			[transactionId],
		)
	).map((r) => r.event_type);

const money = (amount: string, currency = "BRL") => ({ amount, currency });

/** Submits a command built on `wallet`; `externalId` doubles as the reference other commands use. */
function send(
	wallet: Wallet,
	kind: Kind,
	externalId: string,
	overrides: Partial<SubmitWagerTransactionCommand> = {},
): Promise<WagerTransactionResult> {
	return h.submit.execute(
		bet(wallet.id, wallet.playerId, {
			kind,
			externalTransactionId: externalId,
			idempotencyKey: `provider-a:${externalId}`,
			money: money("25.00"),
			...overrides,
		}),
		SUBMIT_CONTEXT,
	);
}

const ext = (label: string) => `${label}-${uniqueId()}`;
const BET = Kind.Bet;
const WIN = Kind.Win;
const LOSS = Kind.Loss;
const REFUND = Kind.Refund;
const ROLLBACK = Kind.Rollback;

describe("TST-I-08 reversals (use case, real PostgreSQL)", () => {
	test("TST-I-08 REFUND of a BET restores the balance with one CREDIT entry and links the reference", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const betId = ext("bet");
		const original = await send(wallet, BET, betId);

		const refund = await send(wallet, REFUND, ext("refund"), {
			referenceExternalTransactionId: betId,
		});

		expect(original.balance).toEqual(money("75.00"));
		expect(refund).toMatchObject({
			status: Status.Processed,
			balance: money("100.00"),
			failureCode: null,
			idempotentReplay: false,
		});
		expect(await walletRow(wallet.id)).toEqual({
			balance: "100.00",
			version: 3,
		});
		const ledger = await ledgerOf(wallet.id);
		expect(
			ledger.map((e) => [e.direction, e.amount, e.wallet_version]),
		).toEqual([
			["CREDIT", "100.00", 1],
			["DEBIT", "25.00", 2],
			["CREDIT", "25.00", 3],
		]);
		expect((await txRow(refund.transactionId)).reference_transaction_id).toBe(
			original.transactionId,
		);
		expect(await eventTypes(refund.transactionId)).toEqual([
			"WagerTransactionProcessed",
			"WalletBalanceChanged",
		]);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-08 ROLLBACK of a BET credits (inverse of the debit)", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const betId = ext("bet");
		await send(wallet, BET, betId);

		const rollback = await send(wallet, ROLLBACK, ext("rb"), {
			referenceExternalTransactionId: betId,
		});

		expect(rollback.status).toBe(Status.Processed);
		expect(rollback.balance).toEqual(money("100.00"));
		expect((await ledgerOf(wallet.id)).at(-1)).toMatchObject({
			direction: "CREDIT",
			amount: "25.00",
			wallet_version: 3,
		});
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-08 ROLLBACK of a WIN debits (inverse of the credit)", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const winId = ext("win");
		await send(wallet, WIN, winId); // 125.00

		const rollback = await send(wallet, ROLLBACK, ext("rb"), {
			referenceExternalTransactionId: winId,
		});

		expect(rollback.status).toBe(Status.Processed);
		expect(rollback.balance).toEqual(money("100.00"));
		expect((await ledgerOf(wallet.id)).at(-1)).toMatchObject({
			direction: "DEBIT",
			amount: "25.00",
			wallet_version: 3,
			balance_after: "100.00",
		});
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-08 ROLLBACK of a REFUND debits (inverse of the credit)", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const betId = ext("bet");
		const refundId = ext("refund");
		await send(wallet, BET, betId); // 75
		await send(wallet, REFUND, refundId, {
			referenceExternalTransactionId: betId,
		}); // 100

		const rollback = await send(wallet, ROLLBACK, ext("rb"), {
			referenceExternalTransactionId: refundId,
		});

		expect(rollback.status).toBe(Status.Processed);
		expect(rollback.balance).toEqual(money("75.00"));
		expect((await ledgerOf(wallet.id)).at(-1)).toMatchObject({
			direction: "DEBIT",
			amount: "25.00",
			wallet_version: 4,
		});
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-08 KEY SCENARIO: 100.00 -> BET 25 (75.00) -> REFUND (100.00) -> ROLLBACK of the same BET is REJECTED REFERENCE_ALREADY_REVERSED and the balance stays 100.00", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const betId = ext("bet");
		const placed = await send(wallet, BET, betId);
		const refund = await send(wallet, REFUND, ext("refund"), {
			referenceExternalTransactionId: betId,
		});
		expect(placed.balance).toEqual(money("75.00"));
		expect(refund.balance).toEqual(money("100.00"));
		const ledgerBefore = await ledgerOf(wallet.id);

		const rollback = await send(wallet, ROLLBACK, ext("rb"), {
			referenceExternalTransactionId: betId,
		});

		expect(rollback).toMatchObject({
			status: Status.Rejected,
			failureCode: FailureCode.ReferenceAlreadyReversed,
			balance: money("100.00"),
		});
		expect(await walletRow(wallet.id)).toEqual({
			balance: "100.00",
			version: 3,
		});
		expect(await ledgerOf(wallet.id)).toEqual(ledgerBefore);
		expect(await eventTypes(rollback.transactionId)).toEqual([
			"WagerTransactionRejected",
		]);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-08 the other order is refused too: ROLLBACK first, then REFUND of the same BET", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const betId = ext("bet");
		await send(wallet, BET, betId);
		await send(wallet, ROLLBACK, ext("rb"), {
			referenceExternalTransactionId: betId,
		});

		const refund = await send(wallet, REFUND, ext("refund"), {
			referenceExternalTransactionId: betId,
		});

		expect(refund).toMatchObject({
			status: Status.Rejected,
			failureCode: FailureCode.ReferenceAlreadyReversed,
			balance: money("100.00"),
		});
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-08 a reversal that would leave the balance negative is REJECTED REVERSAL_WOULD_OVERDRAW: no ledger, version intact", async () => {
		const wallet = await openWalletWithOpening(p, "10.00");
		const winId = ext("win");
		await send(wallet, WIN, winId, { money: money("50.00") }); // 60.00
		await send(wallet, BET, ext("bet"), { money: money("55.00") }); // 5.00
		const before = await walletRow(wallet.id);
		const ledgerBefore = await ledgerOf(wallet.id);

		const rollback = await send(wallet, ROLLBACK, ext("rb"), {
			money: money("50.00"),
			referenceExternalTransactionId: winId,
		});

		expect(rollback).toMatchObject({
			status: Status.Rejected,
			failureCode: FailureCode.ReversalWouldOverdraw,
			balance: money("5.00"),
		});
		expect(await walletRow(wallet.id)).toEqual(before);
		expect(await ledgerOf(wallet.id)).toEqual(ledgerBefore);
		expect(await eventTypes(rollback.transactionId)).toEqual([
			"WagerTransactionRejected",
		]);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});
});

describe("TST-I-09 reference validation (use case, real PostgreSQL)", () => {
	async function expectRejected(
		wallet: Wallet,
		result: WagerTransactionResult,
		code: FailureCode,
		balance: string,
	) {
		expect(result).toMatchObject({
			status: Status.Rejected,
			failureCode: code,
			balance: money(balance),
			idempotentReplay: false,
		});
		expect((await txRow(result.transactionId))?.failure_code).toBe(code);
		expect(await eventTypes(result.transactionId)).toEqual([
			"WagerTransactionRejected",
		]);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	}

	test("TST-I-09 REFUND of a WIN is REFERENCE_KIND_NOT_ALLOWED", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const winId = ext("win");
		await send(wallet, WIN, winId);
		const result = await send(wallet, REFUND, ext("refund"), {
			referenceExternalTransactionId: winId,
		});
		await expectRejected(
			wallet,
			result,
			FailureCode.ReferenceKindNotAllowed,
			"125.00",
		);
	});

	test("TST-I-09 ROLLBACK of a LOSS is REFERENCE_KIND_NOT_ALLOWED", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const lossId = ext("loss");
		await send(wallet, LOSS, lossId);
		const result = await send(wallet, ROLLBACK, ext("rb"), {
			referenceExternalTransactionId: lossId,
		});
		await expectRejected(
			wallet,
			result,
			FailureCode.ReferenceKindNotAllowed,
			"100.00",
		);
	});

	test("TST-I-09 ROLLBACK of a ROLLBACK is REFERENCE_KIND_NOT_ALLOWED", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const betId = ext("bet");
		const rbId = ext("rb");
		await send(wallet, BET, betId);
		await send(wallet, ROLLBACK, rbId, {
			referenceExternalTransactionId: betId,
		});
		const result = await send(wallet, ROLLBACK, ext("rb2"), {
			referenceExternalTransactionId: rbId,
		});
		await expectRejected(
			wallet,
			result,
			FailureCode.ReferenceKindNotAllowed,
			"100.00",
		);
	});

	test("TST-I-09 WIN referencing a WIN is REFERENCE_KIND_NOT_ALLOWED", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const winId = ext("win");
		await send(wallet, WIN, winId);
		const result = await send(wallet, WIN, ext("win2"), {
			referenceExternalTransactionId: winId,
		});
		await expectRejected(
			wallet,
			result,
			FailureCode.ReferenceKindNotAllowed,
			"125.00",
		);
	});

	test("TST-I-09 a transaction referencing itself is REFERENCE_KIND_NOT_ALLOWED, never processed", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const selfId = ext("self");
		const result = await send(wallet, REFUND, selfId, {
			referenceExternalTransactionId: selfId,
		});
		await expectRejected(
			wallet,
			result,
			FailureCode.ReferenceKindNotAllowed,
			"100.00",
		);
	});

	test("TST-I-09 WIN and LOSS may reference a BET: processed, reference linked", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const betId = ext("bet");
		const placed = await send(wallet, BET, betId); // 75
		const win = await send(wallet, WIN, ext("win"), {
			money: money("10.00"),
			referenceExternalTransactionId: betId,
		});
		const loss = await send(wallet, LOSS, ext("loss"), {
			referenceExternalTransactionId: betId,
		});

		expect(win).toMatchObject({
			status: Status.Processed,
			balance: money("85.00"),
		});
		expect(loss).toMatchObject({
			status: Status.Processed,
			balance: money("85.00"),
		});
		expect((await txRow(win.transactionId))?.reference_transaction_id).toBe(
			placed.transactionId,
		);
		expect((await txRow(loss.transactionId))?.reference_transaction_id).toBe(
			placed.transactionId,
		);
		expect(await walletRow(wallet.id)).toEqual({
			balance: "85.00",
			version: 3,
		});
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-09 a reference in ANOTHER wallet of the same provider is REFERENCE_MISMATCH (no wallet filter)", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const other = await openWalletWithOpening(p, "100.00");
		const otherBet = ext("bet-elsewhere");
		await send(other, BET, otherBet);

		const result = await send(wallet, REFUND, ext("refund"), {
			referenceExternalTransactionId: otherBet,
		});

		await expectRejected(
			wallet,
			result,
			FailureCode.ReferenceMismatch,
			"100.00",
		);
		await assertLedgerInvariant(p.ledgerIntegrity, other.id);
	});

	test("TST-I-09 a reference from another round is REFERENCE_MISMATCH", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const betId = ext("bet");
		await send(wallet, BET, betId);
		const result = await send(wallet, REFUND, ext("refund"), {
			roundId: "round-2",
			referenceExternalTransactionId: betId,
		});
		await expectRejected(
			wallet,
			result,
			FailureCode.ReferenceMismatch,
			"75.00",
		);
	});

	test("TST-I-09 a reference in a wallet of another player and currency is REFERENCE_MISMATCH", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const foreign = await insertWallet(sql, {
			currency: "USD",
			balance: "100.00",
		});
		const foreignBet = ext("bet-usd");
		await insertTransaction(sql, foreign.id as string, {
			external_transaction_id: foreignBet,
			idempotency_key: `provider-a:${foreignBet}`,
			player_id: foreign.player_id,
			currency: "USD",
			status: "PROCESSED",
			processed_at: new Date(),
			observed_balance: "75.00",
			amount: "25.00",
		});

		const result = await send(wallet, REFUND, ext("refund"), {
			referenceExternalTransactionId: foreignBet,
		});

		await expectRejected(
			wallet,
			result,
			FailureCode.ReferenceMismatch,
			"100.00",
		);
	});

	test("TST-I-09 a reversal with a different amount is REVERSAL_AMOUNT_MISMATCH", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const betId = ext("bet");
		await send(wallet, BET, betId);
		const result = await send(wallet, REFUND, ext("refund"), {
			money: money("20.00"),
			referenceExternalTransactionId: betId,
		});
		await expectRejected(
			wallet,
			result,
			FailureCode.ReversalAmountMismatch,
			"75.00",
		);
	});

	test("TST-I-09 a REJECTED reference is REFERENCE_NOT_PROCESSED", async () => {
		const wallet = await openWalletWithOpening(p, "10.00");
		const betId = ext("bet");
		const refused = await send(wallet, BET, betId); // 25 > 10
		expect(refused.failureCode).toBe(FailureCode.InsufficientFunds);

		const result = await send(wallet, REFUND, ext("refund"), {
			referenceExternalTransactionId: betId,
		});

		await expectRejected(
			wallet,
			result,
			FailureCode.ReferenceNotProcessed,
			"10.00",
		);
	});

	test("TST-I-09 a FAILED reference is REFERENCE_NOT_PROCESSED", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const betId = ext("bet");
		await insertTransaction(sql, wallet.id, {
			external_transaction_id: betId,
			idempotency_key: `provider-a:${betId}`,
			player_id: wallet.playerId,
			status: "FAILED",
			failure_code: "PROCESSING_ATTEMPTS_EXHAUSTED",
			amount: "25.00",
		});

		const result = await send(wallet, REFUND, ext("refund"), {
			referenceExternalTransactionId: betId,
		});

		await expectRejected(
			wallet,
			result,
			FailureCode.ReferenceNotProcessed,
			"100.00",
		);
	});

	test("TST-I-09 RF-WAL-05: a reversal in another currency is REJECTED WALLET_CURRENCY_MISMATCH even if its reference is missing", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const result = await send(wallet, REFUND, ext("refund"), {
			money: money("25.00", "USD"),
			referenceExternalTransactionId: ext("not-yet"),
		});
		await expectRejected(
			wallet,
			result,
			FailureCode.WalletCurrencyMismatch,
			"100.00",
		);
	});

	test("TST-I-09 deterministic order when several rules are violated at once (02-design §5)", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const other = await openWalletWithOpening(p, "100.00");
		const winId = ext("win");
		const otherBet = ext("bet-elsewhere");
		const rejectedBet = ext("bet-refused");
		await send(wallet, WIN, winId);
		await send(other, BET, otherBet);
		const poor = await openWalletWithOpening(p, "1.00");
		await send(poor, BET, rejectedBet); // REJECTED

		// player AND currency wrong, reference missing -> player first
		const a = await send(wallet, REFUND, ext("a"), {
			playerId: uniqueId(),
			money: money("25.00", "USD"),
			referenceExternalTransactionId: ext("missing"),
		});
		expect(a.failureCode).toBe(FailureCode.WalletPlayerMismatch);

		// kind wrong AND another wallet AND another amount -> kind first
		const b = await send(wallet, REFUND, ext("b"), {
			money: money("1.00"),
			referenceExternalTransactionId: winId,
		});
		expect(b.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);

		// other wallet AND other amount -> mismatch before amount
		const c = await send(wallet, REFUND, ext("c"), {
			money: money("1.00"),
			referenceExternalTransactionId: otherBet,
		});
		expect(c.failureCode).toBe(FailureCode.ReferenceMismatch);

		// other amount AND a rejected reference -> amount first
		const d = await send(poor, REFUND, ext("d"), {
			money: money("1.00"),
			referenceExternalTransactionId: rejectedBet,
		});
		expect(d.failureCode).toBe(FailureCode.ReversalAmountMismatch);

		// same amount, rejected reference -> not processed
		const e = await send(poor, REFUND, ext("e"), {
			referenceExternalTransactionId: rejectedBet,
			money: money("25.00"),
		});
		expect(e.failureCode).toBe(FailureCode.ReferenceNotProcessed);

		for (const w of [wallet, other, poor]) {
			await assertLedgerInvariant(p.ledgerIntegrity, w.id);
		}
	});
});

describe("TST-I-09 references that have not arrived (PENDING_REFERENCE on entry)", () => {
	test("TST-I-09 a missing reference parks the transaction: observed balance, schedule, one event, no money moved", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const refundId = ext("refund");
		const at = h.clock.now();

		const result = await send(wallet, REFUND, refundId, {
			referenceExternalTransactionId: ext("bet-late"),
		});

		expect(result).toEqual({
			transactionId: result.transactionId,
			status: Status.PendingReference,
			balance: money("100.00"),
			failureCode: null,
			idempotentReplay: false,
		});
		const stored = await txRow(result.transactionId);
		expect(stored).toMatchObject({
			status: "PENDING_REFERENCE",
			reference_attempts: 0,
			observed_balance: "100.00",
			processed_at: null,
			failure_code: null,
			reference_transaction_id: null,
		});
		expect((stored.next_attempt_at as Date).getTime()).toBe(
			at.getTime() + FIRST_PENDING_DELAY_MS,
		);
		expect(await walletRow(wallet.id)).toEqual({
			balance: "100.00",
			version: 1,
		});
		expect(await ledgerOf(wallet.id)).toHaveLength(1);
		expect(await eventTypes(result.transactionId)).toEqual([
			"WagerTransactionPendingReference",
		]);
		const [event] = (await rows(
			"select payload from outbox_messages where payload->'data'->>'transactionId' = $1",
			[result.transactionId],
		)) as [Row];
		expect((event.payload as { data: Row }).data).toMatchObject({
			kind: "REFUND",
			nextAttemptAt: new Date(
				at.getTime() + FIRST_PENDING_DELAY_MS,
			).toISOString(),
		});
		expect(h.metrics.processed.at(-1)).toMatchObject({
			status: "PENDING_REFERENCE",
			kind: "REFUND",
		});
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-09 the PendingReference event is emitted once: a replay adds none and still answers PENDING_REFERENCE", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const command = bet(wallet.id, wallet.playerId, {
			kind: ROLLBACK,
			referenceExternalTransactionId: ext("bet-late"),
		});
		const first = await h.submit.execute(command, SUBMIT_CONTEXT);

		const replay = await h.submit.execute(command, SUBMIT_CONTEXT);

		expect(replay).toEqual({ ...first, idempotentReplay: true });
		expect(replay.status).toBe(Status.PendingReference);
		expect(await eventTypes(first.transactionId)).toEqual([
			"WagerTransactionPendingReference",
		]);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-09 a WIN with a reference that has not arrived is pending too", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const result = await send(wallet, WIN, ext("win"), {
			referenceExternalTransactionId: ext("bet-late"),
		});
		expect(result.status).toBe(Status.PendingReference);
		expect(result.balance).toEqual(money("100.00"));
		expect(await walletRow(wallet.id)).toEqual({
			balance: "100.00",
			version: 1,
		});
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-09 chain: a reference that is itself PENDING_REFERENCE makes this one pending, with its own event", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const winId = ext("win");
		const first = await send(wallet, WIN, winId, {
			referenceExternalTransactionId: ext("bet-late"),
		});

		const second = await send(wallet, ROLLBACK, ext("rb"), {
			referenceExternalTransactionId: winId,
		});

		expect(first.status).toBe(Status.PendingReference);
		expect(second).toMatchObject({
			status: Status.PendingReference,
			balance: money("100.00"),
		});
		expect(await eventTypes(second.transactionId)).toEqual([
			"WagerTransactionPendingReference",
		]);
		expect(await walletRow(wallet.id)).toEqual({
			balance: "100.00",
			version: 1,
		});
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-09 a chain on a reference of the wrong kind is rejected at once, not parked", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const refundId = ext("refund");
		await send(wallet, REFUND, refundId, {
			referenceExternalTransactionId: ext("bet-late"),
		}); // pending

		// REFUND may only reference a BET; the pending REFUND is not one
		const result = await send(wallet, REFUND, ext("refund2"), {
			referenceExternalTransactionId: refundId,
		});

		expect(result.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});
});

describe("TST-I-09 waking the dependents when a transaction is PROCESSED", () => {
	const nextAttemptOf = async (id: string) =>
		((await txRow(id)).next_attempt_at as Date).getTime();

	test("TST-I-09 dependents of the locked wallet become due now; those of another wallet are not touched", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const elsewhere = await openWalletWithOpening(p, "100.00");
		const lateBet = ext("bet-late");
		const refund = await send(wallet, REFUND, ext("refund"), {
			referenceExternalTransactionId: lateBet,
		});
		const rollback = await send(wallet, ROLLBACK, ext("rb"), {
			referenceExternalTransactionId: lateBet,
		});
		const foreign = await send(elsewhere, REFUND, ext("refund-b"), {
			referenceExternalTransactionId: lateBet,
		});
		const scheduled = await nextAttemptOf(refund.transactionId);
		expect(scheduled).toBeGreaterThan(h.clock.now().getTime());
		const foreignScheduled = await nextAttemptOf(foreign.transactionId);
		h.clock.advance(1000);

		const arrived = await send(wallet, BET, lateBet);

		expect(arrived.status).toBe(Status.Processed);
		const now = h.clock.now().getTime();
		expect(await nextAttemptOf(refund.transactionId)).toBe(now);
		expect(await nextAttemptOf(rollback.transactionId)).toBe(now);
		expect(await nextAttemptOf(foreign.transactionId)).toBe(foreignScheduled);
		// still pending: resolving them is the worker's job (T-043)
		expect((await txRow(refund.transactionId)).status).toBe(
			"PENDING_REFERENCE",
		);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
		await assertLedgerInvariant(p.ledgerIntegrity, elsewhere.id);
	});

	test("TST-I-09 a REJECTED arrival does not wake anyone", async () => {
		const wallet = await openWalletWithOpening(p, "10.00");
		const lateBet = ext("bet-late");
		const waiting = await send(wallet, WIN, ext("win"), {
			referenceExternalTransactionId: lateBet,
		});
		const scheduled = await nextAttemptOf(waiting.transactionId);
		h.clock.advance(1000);

		const arrived = await send(wallet, BET, lateBet); // 25 > 10: rejected

		expect(arrived.status).toBe(Status.Rejected);
		expect(await nextAttemptOf(waiting.transactionId)).toBe(scheduled);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-09 a LOSS that is PROCESSED wakes the ones waiting for it", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const lossId = ext("loss");
		// a ROLLBACK may not reference a LOSS, but a WIN cannot either: waiting is by external id only
		const waiting = await send(wallet, WIN, ext("win"), {
			referenceExternalTransactionId: lossId,
		});
		const scheduled = await nextAttemptOf(waiting.transactionId);
		h.clock.advance(1000);

		await send(wallet, LOSS, lossId);

		expect(await nextAttemptOf(waiting.transactionId)).toBe(
			h.clock.now().getTime(),
		);
		expect(await nextAttemptOf(waiting.transactionId)).toBeLessThan(scheduled);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});
});
