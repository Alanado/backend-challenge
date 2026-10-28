import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { Client } from "pg";
import { RequestValidationError } from "../../src/modules/platform/application/validation-error";
import { FailureCode } from "../../src/modules/wagering/domain/failure-code";
import { WagerTransactionKind } from "../../src/modules/wagering/domain/wager-transaction-kind";
import { WagerTransactionStatus } from "../../src/modules/wagering/domain/wager-transaction-status";
import { WalletNotFoundError } from "../../src/modules/wallet/application/errors";
import {
	createFaultInjector,
	InjectedFaultError,
} from "../../src/shared/fault-injector";
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

beforeEach(() => {
	queries.length = 0;
});

type Row = Record<string, unknown>;
const rows = async (text: string, params: unknown[]): Promise<Row[]> =>
	(await sql.query(text, params)).rows as Row[];

const walletRow = async (id: string) =>
	(await rows("select balance, version from wallets where id = $1", [id]))[0];
const ledgerOf = (walletId: string) =>
	rows(
		"select direction, amount, wallet_version, balance_before, balance_after, transaction_id from wallet_ledger_entries where wallet_id = $1 order by wallet_version",
		[walletId],
	);
const txRow = async (id: string) =>
	(await rows("select * from wager_transactions where id = $1", [id]))[0];
interface EventRow {
	id: string;
	group_key: string;
	event_type: string;
	payload: Record<string, unknown> & { data: Row };
}
const eventsOf = async (transactionId: string) =>
	(await rows(
		"select id, group_key, event_type, payload from outbox_messages where payload->'data'->>'transactionId' = $1 order by event_type",
		[transactionId],
	)) as unknown as EventRow[];
const countRows = async (table: string) =>
	Number((await rows(`select count(*)::int as n from ${table}`, []))[0]?.n);

describe("TST-I-06 SubmitWagerTransaction pipeline (use case, real PostgreSQL)", () => {
	test("TST-I-06 BET debits, writes one DEBIT entry and emits Processed + WalletBalanceChanged", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const command = bet(wallet.id, wallet.playerId);

		const result = await h.submit.execute(command, SUBMIT_CONTEXT);

		expect(result).toEqual({
			transactionId: result.transactionId,
			status: WagerTransactionStatus.Processed,
			balance: { amount: "75.00", currency: "BRL" },
			failureCode: null,
			idempotentReplay: false,
		});
		expect(await walletRow(wallet.id)).toEqual({
			balance: "75.00",
			version: 2,
		});
		const ledger = await ledgerOf(wallet.id);
		expect(ledger).toHaveLength(2);
		expect(ledger[1]).toEqual({
			direction: "DEBIT",
			amount: "25.00",
			wallet_version: 2,
			balance_before: "100.00",
			balance_after: "75.00",
			transaction_id: result.transactionId,
		});
		const stored = await txRow(result.transactionId);
		expect(stored?.status).toBe(WagerTransactionStatus.Processed);
		expect(stored?.observed_balance).toBe("75.00");
		expect(stored?.processed_at).toBeInstanceOf(Date);
		expect(stored?.failure_code).toBeNull();

		const events = await eventsOf(result.transactionId);
		expect(events.map((e) => e.event_type)).toEqual([
			"WagerTransactionProcessed",
			"WalletBalanceChanged",
		]);
		const [processed, changed] = events;
		const at = h.clock.now().toISOString();
		expect(processed?.payload).toEqual({
			eventId: processed?.id as string,
			eventType: "WagerTransactionProcessed",
			aggregateId: result.transactionId,
			correlationId: "corr-test",
			causationId: result.transactionId,
			occurredAt: at,
			version: 1,
			data: {
				transactionId: result.transactionId,
				providerId: "provider-a",
				externalTransactionId: command.externalTransactionId,
				walletId: wallet.id,
				roundId: "round-1",
				gameId: "game-1",
				kind: "BET",
				money: { amount: "25.00", currency: "BRL" },
				processedAt: at,
			},
		});
		expect(changed?.payload).toEqual({
			eventId: changed?.id as string,
			eventType: "WalletBalanceChanged",
			aggregateId: wallet.id,
			correlationId: "corr-test",
			causationId: result.transactionId,
			occurredAt: at,
			version: 1,
			data: {
				walletId: wallet.id,
				transactionId: result.transactionId,
				direction: "DEBIT",
				money: { amount: "25.00", currency: "BRL" },
				balanceBefore: { amount: "100.00", currency: "BRL" },
				balanceAfter: { amount: "75.00", currency: "BRL" },
				walletVersion: 2,
			},
		});
		expect(events.every((e) => e.group_key === wallet.id)).toBe(true);
		expect(h.metrics.processed.at(-1)).toEqual({
			status: "PROCESSED",
			kind: "BET",
			channel: "http",
			failureCode: undefined,
		});
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-06 BET without funds is REJECTED INSUFFICIENT_FUNDS: no ledger, version and balance intact, one Rejected event", async () => {
		const wallet = await openWalletWithOpening(p, "10.00");

		const result = await h.submit.execute(
			bet(wallet.id, wallet.playerId, {
				money: { amount: "25.00", currency: "BRL" },
			}),
			SUBMIT_CONTEXT,
		);

		expect(result.status).toBe(WagerTransactionStatus.Rejected);
		expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
		expect(result.balance).toEqual({ amount: "10.00", currency: "BRL" });
		expect(result.idempotentReplay).toBe(false);
		expect(await walletRow(wallet.id)).toEqual({
			balance: "10.00",
			version: 1,
		});
		expect(await ledgerOf(wallet.id)).toHaveLength(1); // only OPENING
		const stored = await txRow(result.transactionId);
		expect(stored?.status).toBe(WagerTransactionStatus.Rejected);
		expect(stored?.failure_code).toBe("INSUFFICIENT_FUNDS");
		expect(stored?.observed_balance).toBe("10.00");
		const events = await eventsOf(result.transactionId);
		expect(events.map((e) => e.event_type)).toEqual([
			"WagerTransactionRejected",
		]);
		expect(events[0]?.payload.data.failureCode).toBe("INSUFFICIENT_FUNDS");
		expect(h.metrics.processed.at(-1)).toEqual({
			status: "REJECTED",
			kind: "BET",
			channel: "http",
			failureCode: "INSUFFICIENT_FUNDS",
		});
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-06 WIN credits the wallet with one CREDIT entry", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");

		const result = await h.submit.execute(
			bet(wallet.id, wallet.playerId, {
				kind: WagerTransactionKind.Win,
				money: { amount: "40.00", currency: "BRL" },
			}),
			SUBMIT_CONTEXT,
		);

		expect(result.status).toBe(WagerTransactionStatus.Processed);
		expect(result.balance).toEqual({ amount: "140.00", currency: "BRL" });
		expect(await walletRow(wallet.id)).toEqual({
			balance: "140.00",
			version: 2,
		});
		const ledger = await ledgerOf(wallet.id);
		expect(ledger[1]).toMatchObject({
			direction: "CREDIT",
			amount: "40.00",
			wallet_version: 2,
			balance_before: "100.00",
			balance_after: "140.00",
		});
		const events = await eventsOf(result.transactionId);
		expect(events.map((e) => e.event_type)).toEqual([
			"WagerTransactionProcessed",
			"WalletBalanceChanged",
		]);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-06 LOSS is PROCESSED without moving balance: version intact, no ledger, only the Processed event", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");

		const result = await h.submit.execute(
			bet(wallet.id, wallet.playerId, { kind: WagerTransactionKind.Loss }),
			SUBMIT_CONTEXT,
		);

		expect(result.status).toBe(WagerTransactionStatus.Processed);
		expect(result.balance).toEqual({ amount: "100.00", currency: "BRL" });
		expect(await walletRow(wallet.id)).toEqual({
			balance: "100.00",
			version: 1,
		});
		expect(await ledgerOf(wallet.id)).toHaveLength(1);
		expect((await txRow(result.transactionId))?.observed_balance).toBe(
			"100.00",
		);
		const events = await eventsOf(result.transactionId);
		expect(events.map((e) => e.event_type)).toEqual([
			"WagerTransactionProcessed",
		]);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-06 a player that does not own the wallet is REJECTED WALLET_PLAYER_MISMATCH and persisted", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");

		const result = await h.submit.execute(
			bet(wallet.id, uniqueId()),
			SUBMIT_CONTEXT,
		);

		expect(result.status).toBe(WagerTransactionStatus.Rejected);
		expect(result.failureCode).toBe(FailureCode.WalletPlayerMismatch);
		expect(result.balance).toEqual({ amount: "100.00", currency: "BRL" });
		expect((await txRow(result.transactionId))?.failure_code).toBe(
			"WALLET_PLAYER_MISMATCH",
		);
		expect(await walletRow(wallet.id)).toEqual({
			balance: "100.00",
			version: 1,
		});
		expect(await ledgerOf(wallet.id)).toHaveLength(1);
		expect(
			(await eventsOf(result.transactionId)).map((e) => e.event_type),
		).toEqual(["WagerTransactionRejected"]);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-06 a currency different from the wallet's is REJECTED WALLET_CURRENCY_MISMATCH and persisted", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");

		const result = await h.submit.execute(
			bet(wallet.id, wallet.playerId, {
				money: { amount: "25.00", currency: "USD" },
			}),
			SUBMIT_CONTEXT,
		);

		expect(result.status).toBe(WagerTransactionStatus.Rejected);
		expect(result.failureCode).toBe(FailureCode.WalletCurrencyMismatch);
		expect((await txRow(result.transactionId))?.status).toBe(
			WagerTransactionStatus.Rejected,
		);
		expect(await walletRow(wallet.id)).toEqual({
			balance: "100.00",
			version: 1,
		});
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-06 an unknown wallet raises WalletNotFoundError and persists nothing", async () => {
		const command = bet(uniqueId(), uniqueId());

		await expect(
			h.submit.execute(command, SUBMIT_CONTEXT),
		).rejects.toBeInstanceOf(WalletNotFoundError);

		expect(
			await rows(
				"select 1 from wager_transactions where external_transaction_id = $1",
				[command.externalTransactionId],
			),
		).toHaveLength(0);
		expect(
			await rows("select 1 from outbox_messages where group_key = $1", [
				command.walletId,
			]),
		).toHaveLength(0);
	});

	test("TST-I-06 an OPENING submission is refused as a validation error and persists nothing", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const command = bet(wallet.id, wallet.playerId, {
			kind: WagerTransactionKind.Opening,
		});

		await expect(
			h.submit.execute(command, SUBMIT_CONTEXT),
		).rejects.toBeInstanceOf(RequestValidationError);

		expect(
			await rows(
				"select 1 from wager_transactions where external_transaction_id = $1",
				[command.externalTransactionId],
			),
		).toHaveLength(0);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});
});

describe("TST-I-05 atomicity with TEST_FAULT=fail-mid-transaction (use case)", () => {
	test("TST-I-05 the injected failure rolls back wallet, ledger, transaction, inbox and outbox", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const faulty = createSubmitHarness(p, { fault: "fail-mid-transaction" });
		const command = bet(wallet.id, wallet.playerId);
		const before = {
			wallet: await walletRow(wallet.id),
			ledger: await ledgerOf(wallet.id),
			transactions: await countRows("wager_transactions"),
			inbox: await countRows("inbox_messages"),
			outbox: await countRows("outbox_messages"),
		};

		await expect(
			faulty.submit.execute(command, SUBMIT_CONTEXT),
		).rejects.toBeInstanceOf(InjectedFaultError);

		expect(await walletRow(wallet.id)).toEqual(before.wallet);
		expect(await walletRow(wallet.id)).toEqual({
			balance: "100.00",
			version: 1,
		});
		expect(await ledgerOf(wallet.id)).toEqual(before.ledger);
		expect(await countRows("wager_transactions")).toBe(before.transactions);
		expect(
			await rows(
				"select 1 from wager_transactions where external_transaction_id = $1",
				[command.externalTransactionId],
			),
		).toHaveLength(0);
		expect(await countRows("inbox_messages")).toBe(before.inbox);
		expect(await countRows("outbox_messages")).toBe(before.outbox);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-05 the fault fires for rejections and LOSS too, and leaves their rows out as well", async () => {
		const wallet = await openWalletWithOpening(p, "10.00");
		const faulty = createSubmitHarness(p, {
			faults: createFaultInjector("fail-mid-transaction"),
		});
		const outboxBefore = await countRows("outbox_messages");
		const transactionsBefore = await countRows("wager_transactions");

		await expect(
			faulty.submit.execute(
				bet(wallet.id, wallet.playerId, {
					money: { amount: "50.00", currency: "BRL" },
				}),
				SUBMIT_CONTEXT,
			),
		).rejects.toBeInstanceOf(InjectedFaultError);
		await expect(
			faulty.submit.execute(
				bet(wallet.id, wallet.playerId, { kind: WagerTransactionKind.Loss }),
				SUBMIT_CONTEXT,
			),
		).rejects.toBeInstanceOf(InjectedFaultError);

		expect(await countRows("outbox_messages")).toBe(outboxBefore);
		expect(await countRows("wager_transactions")).toBe(transactionsBefore);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});
});

describe("X-LOCK-ORDER canonical lock order (ADR-0007)", () => {
	test("X-LOCK-ORDER the wallet SELECT … FOR UPDATE is issued before the INSERT into wager_transactions", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		queries.length = 0;

		await h.submit.execute(bet(wallet.id, wallet.playerId), SUBMIT_CONTEXT);

		const lock = queries.findIndex(
			(q) => /\bwallets\b/i.test(q) && /\bfor update\b/i.test(q),
		);
		const insert = queries.findIndex((q) =>
			/insert into "?wager_transactions"?/i.test(q),
		);
		expect(lock).toBeGreaterThanOrEqual(0);
		expect(insert).toBeGreaterThanOrEqual(0);
		expect(lock).toBeLessThan(insert);
		// Before the wallet lock only the lock-free fast-path read may touch wager_transactions.
		const touching = queries
			.slice(0, lock)
			.filter((q) => /wager_transactions/i.test(q));
		for (const statement of touching) {
			expect(statement).toMatch(/^\s*select\b/i);
			expect(statement).not.toMatch(/\bfor (update|share|key share)\b/i);
		}
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});
});
