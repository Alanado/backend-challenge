import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { createWorkerRig, FAST_BACKOFF } from "../support/pending-env";
import { createPersistence, type Persistence } from "../support/persistence";
import { connect } from "../support/sql";
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
let rig: ReturnType<typeof createWorkerRig>;

// A database per test: the worker reads every due candidate, so tests must not share pendings.
beforeEach(async () => {
	db = await createSuiteDatabase();
	sql = await connect(db.url);
	p = await createPersistence(db.url);
	h = createSubmitHarness(p, { backoff: FAST_BACKOFF });
	rig = createWorkerRig(p, { clock: h.clock });
});

afterEach(async () => {
	await p.close();
	await sql.end();
	await db.drop();
});

type Row = Record<string, unknown>;
const rows = async (text: string, params: unknown[]): Promise<Row[]> =>
	(await sql.query(text, params)).rows as Row[];
const walletRow = async (id: string) =>
	(await rows("select balance, version from wallets where id = $1", [id]))[0];
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
const ledgerOf = (walletId: string) =>
	rows(
		"select direction, amount, wallet_version from wallet_ledger_entries where wallet_id = $1 order by wallet_version",
		[walletId],
	);

const ext = (label: string) => `${label}-${uniqueId()}`;

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
			money: { amount: "25.00", currency: "BRL" },
			...overrides,
		}),
		SUBMIT_CONTEXT,
	);
}

describe("TST-I-10 PENDING_REFERENCE worker (real PostgreSQL)", () => {
	test("TST-I-10 a REFUND that arrives before its BET waits, is woken by the BET and is processed by the worker", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const betId = ext("bet");

		const refund = await send(wallet, Kind.Refund, ext("refund"), {
			referenceExternalTransactionId: betId,
		});
		expect(refund.status).toBe(Status.PendingReference);
		expect(refund.balance).toEqual({ amount: "100.00", currency: "BRL" });
		expect(await eventTypes(refund.transactionId)).toEqual([
			"WagerTransactionPendingReference",
		]);
		// Not due yet: the worker leaves it alone.
		expect((await rig.worker.runOnce()).candidates).toBe(0);

		const original = await send(wallet, Kind.Bet, betId);
		expect(original.status).toBe(Status.Processed);
		// The BET woke the dependent of the same wallet: due right now.
		expect(
			new Date(
				(await txRow(refund.transactionId)).next_attempt_at as Date,
			).getTime(),
		).toBe(h.clock.now().getTime());

		const pass = await rig.worker.runOnce();

		expect(pass).toMatchObject({ candidates: 1, processed: 1, errors: 0 });
		expect(await txRow(refund.transactionId)).toMatchObject({
			status: Status.Processed,
			reference_transaction_id: original.transactionId,
			failure_code: null,
			next_attempt_at: null,
		});
		expect(await walletRow(wallet.id)).toEqual({
			balance: "100.00",
			version: 3,
		});
		expect(
			(await ledgerOf(wallet.id)).map((e) => [
				e.direction,
				e.amount,
				e.wallet_version,
			]),
		).toEqual([
			["CREDIT", "100.00", 1],
			["DEBIT", "25.00", 2],
			["CREDIT", "25.00", 3],
		]);
		// PendingReference once, then Processed + WalletBalanceChanged; no second pending event.
		expect(await eventTypes(refund.transactionId)).toEqual([
			"WagerTransactionPendingReference",
			"WagerTransactionProcessed",
			"WalletBalanceChanged",
		]);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-10 a reference that never arrives is rejected REFERENCE_NOT_FOUND after exactly PENDING_REF_MAX_ATTEMPTS retries", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const refund = await send(wallet, Kind.Refund, ext("refund"), {
			referenceExternalTransactionId: ext("never"),
		});
		const attemptsOf = async () =>
			(await txRow(refund.transactionId)).reference_attempts;

		h.clock.advance(5000);
		expect(await rig.worker.runOnce()).toMatchObject({
			rescheduled: 1,
			rejected: 0,
		});
		expect(await attemptsOf()).toBe(1);
		const afterFirst = await txRow(refund.transactionId);
		expect(afterFirst.status).toBe(Status.PendingReference);
		// Rescheduled into the future by the backoff (attempt 1: 100 ms * 2, equal jitter 0.5 => 150 ms).
		expect(new Date(afterFirst.next_attempt_at as Date).getTime()).toBe(
			h.clock.now().getTime() + 150,
		);

		h.clock.advance(5000);
		expect(await rig.worker.runOnce()).toMatchObject({
			rescheduled: 1,
			rejected: 0,
		});
		expect(await attemptsOf()).toBe(2);
		expect((await txRow(refund.transactionId)).status).toBe(
			Status.PendingReference,
		);

		h.clock.advance(5000);
		expect(await rig.worker.runOnce()).toMatchObject({
			rescheduled: 0,
			rejected: 1,
		});
		expect(await txRow(refund.transactionId)).toMatchObject({
			status: Status.Rejected,
			failure_code: FailureCode.ReferenceNotFound,
			reference_attempts: FAST_BACKOFF.maxAttempts,
			next_attempt_at: null,
		});
		expect(await eventTypes(refund.transactionId)).toEqual([
			"WagerTransactionPendingReference",
			"WagerTransactionRejected",
		]);
		expect(await walletRow(wallet.id)).toEqual({
			balance: "100.00",
			version: 1,
		});
		expect(rig.metrics.retries).toEqual([
			"pending_reference",
			"pending_reference",
		]);

		// Terminal: nothing is left for the worker.
		h.clock.advance(5000);
		expect((await rig.worker.runOnce()).candidates).toBe(0);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-10 a chain ROLLBACK -> REFUND -> BET resolves in order as each reference is processed", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const betId = ext("bet");
		const refundId = ext("refund");
		const rollback = await send(wallet, Kind.Rollback, ext("rollback"), {
			referenceExternalTransactionId: refundId,
		});
		const refund = await send(wallet, Kind.Refund, refundId, {
			referenceExternalTransactionId: betId,
		});
		expect(rollback.status).toBe(Status.PendingReference);
		expect(refund.status).toBe(Status.PendingReference);

		await send(wallet, Kind.Bet, betId);

		// Pass 1: only the REFUND was woken by the BET; processing it wakes the ROLLBACK.
		expect(await rig.worker.runOnce()).toMatchObject({
			candidates: 1,
			processed: 1,
		});
		expect((await txRow(refund.transactionId)).status).toBe(Status.Processed);
		expect((await txRow(rollback.transactionId)).status).toBe(
			Status.PendingReference,
		);

		expect(await rig.worker.runOnce()).toMatchObject({
			candidates: 1,
			processed: 1,
		});
		expect((await txRow(rollback.transactionId)).status).toBe(Status.Processed);

		expect(await walletRow(wallet.id)).toEqual({
			balance: "75.00",
			version: 4,
		});
		expect(
			(await ledgerOf(wallet.id)).map((e) => [e.direction, e.wallet_version]),
		).toEqual([
			["CREDIT", 1],
			["DEBIT", 2],
			["CREDIT", 3],
			["DEBIT", 4],
		]);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-10 a mismatch found on the retry rejects with REFERENCE_MISMATCH and the event", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const betId = ext("bet");
		const refund = await send(wallet, Kind.Refund, ext("refund"), {
			referenceExternalTransactionId: betId,
		});
		// The reference arrives, but in another round.
		await send(wallet, Kind.Bet, betId, { roundId: "round-2" });

		expect(await rig.worker.runOnce()).toMatchObject({
			rejected: 1,
			processed: 0,
		});

		expect(await txRow(refund.transactionId)).toMatchObject({
			status: Status.Rejected,
			failure_code: FailureCode.ReferenceMismatch,
		});
		expect(await eventTypes(refund.transactionId)).toEqual([
			"WagerTransactionPendingReference",
			"WagerTransactionRejected",
		]);
		expect(await walletRow(wallet.id)).toEqual({
			balance: "75.00",
			version: 2,
		});
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-10 a dependent of another wallet is not woken: it waits for its backoff and then mismatches", async () => {
		const first = await openWalletWithOpening(p, "100.00");
		const second = await openWalletWithOpening(p, "100.00");
		const betId = ext("bet");
		const refund = await send(first, Kind.Refund, ext("refund"), {
			referenceExternalTransactionId: betId,
		});
		const scheduled = (await txRow(refund.transactionId))
			.next_attempt_at as Date;

		await send(second, Kind.Bet, betId);

		const afterBet = (await txRow(refund.transactionId))
			.next_attempt_at as Date;
		expect(new Date(afterBet).getTime()).toBe(new Date(scheduled).getTime());
		expect((await rig.worker.runOnce()).candidates).toBe(0);

		h.clock.advance(1000);
		expect(await rig.worker.runOnce()).toMatchObject({ rejected: 1 });
		expect(await txRow(refund.transactionId)).toMatchObject({
			status: Status.Rejected,
			failure_code: FailureCode.ReferenceMismatch,
		});
		await assertLedgerInvariant(p.ledgerIntegrity, first.id);
		await assertLedgerInvariant(p.ledgerIntegrity, second.id);
	});
});
