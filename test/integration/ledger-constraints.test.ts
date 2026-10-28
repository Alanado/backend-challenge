import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { uniqueId } from "../support/ids";
import {
	CHECK_VIOLATION,
	connect,
	FK_VIOLATION,
	failureOf,
	insertLedgerEntry,
	insertTransaction,
	insertWallet,
	UNIQUE_VIOLATION,
} from "../support/sql";
import {
	createSuiteDatabase,
	type SuiteDatabase,
} from "../support/suite-database";

let db: SuiteDatabase;
let client: Client;

beforeAll(async () => {
	db = await createSuiteDatabase();
	client = await connect(db.url);
});

afterAll(async () => {
	await client.end();
	await db.drop();
});

async function walletWithTransaction(): Promise<{
	walletId: string;
	transactionId: string;
}> {
	const walletId = (await insertWallet(client)).id as string;
	const transactionId = (await insertTransaction(client, walletId))
		.id as string;
	return { walletId, transactionId };
}

describe("TST-I-02 wallet_ledger_entries constraints (raw SQL)", () => {
	test("TST-I-02 ledger: a consistent CREDIT and a consistent DEBIT are accepted", async () => {
		const { walletId, transactionId } = await walletWithTransaction();
		const credit = await insertLedgerEntry(client, walletId, transactionId);
		expect(credit.balance_after).toBe("110.00");
		const other = (await insertTransaction(client, walletId)).id as string;
		const debit = await insertLedgerEntry(client, walletId, other, {
			wallet_version: 3,
			direction: "DEBIT",
			amount: "10.00",
			balance_before: "110.00",
			balance_after: "100.00",
		});
		expect(debit.direction).toBe("DEBIT");
	});

	test("TST-I-02 le_arithmetic: CREDIT must add the amount", async () => {
		const { walletId, transactionId } = await walletWithTransaction();
		const failure = await failureOf(
			insertLedgerEntry(client, walletId, transactionId, {
				direction: "CREDIT",
				balance_before: "100.00",
				amount: "10.00",
				balance_after: "109.99",
			}),
		);
		expect(failure.code).toBe(CHECK_VIOLATION);
		expect(failure.constraint).toBe("le_arithmetic");
	});

	test("TST-I-02 le_arithmetic: DEBIT must subtract the amount", async () => {
		const { walletId, transactionId } = await walletWithTransaction();
		const failure = await failureOf(
			insertLedgerEntry(client, walletId, transactionId, {
				direction: "DEBIT",
				balance_before: "100.00",
				amount: "10.00",
				balance_after: "110.00",
			}),
		);
		expect(failure.code).toBe(CHECK_VIOLATION);
		expect(failure.constraint).toBe("le_arithmetic");
	});

	test("TST-I-02 ledger: direction outside DEBIT/CREDIT is rejected", async () => {
		const { walletId, transactionId } = await walletWithTransaction();
		const failure = await failureOf(
			insertLedgerEntry(client, walletId, transactionId, { direction: "SWAP" }),
		);
		// Postgres evaluates CHECKs by name; le_arithmetic also rejects an unknown direction, and sorts first.
		expect(failure.code).toBe(CHECK_VIOLATION);
		expect([
			"le_arithmetic",
			"wallet_ledger_entries_direction_check",
		]).toContain(failure.constraint as string);
	});

	test("TST-I-02 ledger: amount must be > 0", async () => {
		const { walletId, transactionId } = await walletWithTransaction();
		const failure = await failureOf(
			insertLedgerEntry(client, walletId, transactionId, {
				amount: "0.00",
				balance_after: "100.00",
			}),
		);
		expect(failure.constraint).toBe("wallet_ledger_entries_amount_check");
	});

	test("TST-I-02 ledger: balance_before must be >= 0", async () => {
		const { walletId, transactionId } = await walletWithTransaction();
		const failure = await failureOf(
			insertLedgerEntry(client, walletId, transactionId, {
				balance_before: "-10.00",
				balance_after: "0.00",
			}),
		);
		expect(failure.constraint).toBe(
			"wallet_ledger_entries_balance_before_check",
		);
	});

	test("TST-I-02 ledger: balance_after must be >= 0 (a DEBIT cannot overdraw)", async () => {
		const { walletId, transactionId } = await walletWithTransaction();
		const failure = await failureOf(
			insertLedgerEntry(client, walletId, transactionId, {
				direction: "DEBIT",
				balance_before: "5.00",
				amount: "10.00",
				balance_after: "-5.00",
			}),
		);
		expect(failure.code).toBe(CHECK_VIOLATION);
		expect(failure.constraint).toBe(
			"wallet_ledger_entries_balance_after_check",
		);
	});

	test("TST-I-02 le_one_per_tx: one ledger entry per (wallet, transaction)", async () => {
		const { walletId, transactionId } = await walletWithTransaction();
		await insertLedgerEntry(client, walletId, transactionId, {
			wallet_version: 2,
		});
		const failure = await failureOf(
			insertLedgerEntry(client, walletId, transactionId, { wallet_version: 3 }),
		);
		expect(failure.code).toBe(UNIQUE_VIOLATION);
		expect(failure.constraint).toBe("le_one_per_tx");
	});

	test("TST-I-02 le_version_uk: one ledger entry per (wallet, wallet_version)", async () => {
		const { walletId, transactionId } = await walletWithTransaction();
		await insertLedgerEntry(client, walletId, transactionId, {
			wallet_version: 2,
		});
		const other = (await insertTransaction(client, walletId)).id as string;
		const failure = await failureOf(
			insertLedgerEntry(client, walletId, other, { wallet_version: 2 }),
		);
		expect(failure.code).toBe(UNIQUE_VIOLATION);
		expect(failure.constraint).toBe("le_version_uk");
	});

	test("TST-I-02 ledger FK: wallet_id must exist", async () => {
		const { transactionId } = await walletWithTransaction();
		const failure = await failureOf(
			insertLedgerEntry(client, uniqueId(), transactionId),
		);
		expect(failure.code).toBe(FK_VIOLATION);
		expect(failure.constraint).toBe("wallet_ledger_entries_wallet_id_fkey");
	});

	test("TST-I-02 ledger FK: transaction_id must exist", async () => {
		const { walletId } = await walletWithTransaction();
		const failure = await failureOf(
			insertLedgerEntry(client, walletId, uniqueId()),
		);
		expect(failure.code).toBe(FK_VIOLATION);
		expect(failure.constraint).toBe(
			"wallet_ledger_entries_transaction_id_fkey",
		);
	});
});

describe("TST-I-03 ledger is append-only", () => {
	test("TST-I-03 the test role is the owner and a superuser (the strongest case)", async () => {
		const res = await client.query(
			"select r.rolsuper, pg_get_userbyid(c.relowner) = current_user as is_owner from pg_roles r, pg_class c where r.rolname = current_user and c.relname = 'wallet_ledger_entries'",
		);
		expect(res.rows[0]).toEqual({ rolsuper: true, is_owner: true });
	});

	test("TST-I-03 UPDATE fails, even for the owner, and the row is unchanged", async () => {
		const { walletId, transactionId } = await walletWithTransaction();
		const entry = await insertLedgerEntry(client, walletId, transactionId);
		const failure = await failureOf(
			client.query(
				"update wallet_ledger_entries set amount = '99.00', balance_after = '199.00' where id = $1",
				[entry.id],
			),
		);
		expect(failure.message).toContain("append-only");
		expect(failure.message).toContain("UPDATE");
		const after = await client.query(
			"select amount from wallet_ledger_entries where id = $1",
			[entry.id],
		);
		expect(after.rows[0].amount).toBe("10.00");
	});

	test("TST-I-03 DELETE fails, even for the owner, and the row stays", async () => {
		const { walletId, transactionId } = await walletWithTransaction();
		const entry = await insertLedgerEntry(client, walletId, transactionId);
		const failure = await failureOf(
			client.query("delete from wallet_ledger_entries where id = $1", [
				entry.id,
			]),
		);
		expect(failure.message).toContain("append-only");
		expect(failure.message).toContain("DELETE");
		const after = await client.query(
			"select 1 from wallet_ledger_entries where id = $1",
			[entry.id],
		);
		expect(after.rowCount).toBe(1);
	});

	test("TST-I-03 TRUNCATE fails, even for the owner, and the rows stay", async () => {
		const { walletId, transactionId } = await walletWithTransaction();
		const entry = await insertLedgerEntry(client, walletId, transactionId);
		const failure = await failureOf(
			client.query("truncate wallet_ledger_entries"),
		);
		expect(failure.message).toContain("append-only");
		expect(failure.message).toContain("TRUNCATE");
		const after = await client.query(
			"select 1 from wallet_ledger_entries where id = $1",
			[entry.id],
		);
		expect(after.rowCount).toBe(1);
	});

	test("TST-I-03 TRUNCATE ... CASCADE from a referenced table is also blocked", async () => {
		const failure = await failureOf(client.query("truncate wallets cascade"));
		expect(failure.message).toContain("append-only");
	});
});
