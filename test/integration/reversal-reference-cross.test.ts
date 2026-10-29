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
const txRow = async (id: string): Promise<Row | undefined> =>
	(await rows("select * from wager_transactions where id = $1", [id]))[0];

const money = (amount: string) => ({ amount, currency: "BRL" });
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
			money: money("25.00"),
			...overrides,
		}),
		SUBMIT_CONTEXT,
	);
}

/** 100.00 -> BET 25.00 (75.00) -> REFUND of that BET (100.00). */
async function walletWithRevertedBet(): Promise<{
	wallet: Wallet;
	betId: string;
}> {
	const wallet = await openWalletWithOpening(p, "100.00");
	const betId = ext("bet");
	const placed = await send(wallet, Kind.Bet, betId);
	const refund = await send(wallet, Kind.Refund, ext("refund"), {
		referenceExternalTransactionId: betId,
	});
	expect(placed).toMatchObject({
		status: Status.Processed,
		balance: money("75.00"),
	});
	expect(refund).toMatchObject({
		status: Status.Processed,
		balance: money("100.00"),
	});
	return { wallet, betId };
}

describe("TST-I-21 WIN/LOSS referencing an already reverted BET (real PostgreSQL)", () => {
	for (const kind of [Kind.Win, Kind.Loss]) {
		test(`TST-I-21 ${kind} referencing a reverted BET is REJECTED REFERENCE_ALREADY_REVERSED: balance, version and ledger untouched, rejection persisted`, async () => {
			const { wallet, betId } = await walletWithRevertedBet();
			const walletBefore = await walletRow(wallet.id);
			const ledgerBefore = await ledgerOf(wallet.id);

			const reply = await send(wallet, kind, ext(kind.toLowerCase()), {
				money: money("10.00"),
				referenceExternalTransactionId: betId,
			});

			expect(reply).toMatchObject({
				status: Status.Rejected,
				failureCode: FailureCode.ReferenceAlreadyReversed,
				balance: money("100.00"),
				idempotentReplay: false,
			});
			expect(walletBefore).toEqual({ balance: "100.00", version: 3 });
			expect(await walletRow(wallet.id)).toEqual(walletBefore);
			expect(await ledgerOf(wallet.id)).toEqual(ledgerBefore);
			expect(await txRow(reply.transactionId)).toMatchObject({
				kind,
				status: Status.Rejected,
				failure_code: FailureCode.ReferenceAlreadyReversed,
			});
			await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
		});
	}

	test("TST-I-21 replaying the rejected WIN answers the same result with idempotentReplay true and changes nothing", async () => {
		const { wallet, betId } = await walletWithRevertedBet();
		const winId = ext("win");
		const command = {
			money: money("10.00"),
			referenceExternalTransactionId: betId,
		};
		const first = await send(wallet, Kind.Win, winId, command);
		const ledgerBefore = await ledgerOf(wallet.id);

		const replay = await send(wallet, Kind.Win, winId, command);

		expect(first.status).toBe(Status.Rejected);
		expect(replay).toEqual({ ...first, idempotentReplay: true });
		expect(await walletRow(wallet.id)).toEqual({
			balance: "100.00",
			version: 3,
		});
		expect(await ledgerOf(wallet.id)).toEqual(ledgerBefore);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-21 control: WIN referencing a BET that was NOT reverted stays PROCESSED and credits the wallet", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const betId = ext("bet");
		await send(wallet, Kind.Bet, betId); // 75.00

		const win = await send(wallet, Kind.Win, ext("win"), {
			money: money("10.00"),
			referenceExternalTransactionId: betId,
		});

		expect(win).toMatchObject({
			status: Status.Processed,
			failureCode: null,
			balance: money("85.00"),
		});
		expect(await walletRow(wallet.id)).toEqual({
			balance: "85.00",
			version: 3,
		});
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});
});
