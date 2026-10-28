import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { WagerTransactionKind } from "../../src/modules/wagering/domain/wager-transaction-kind";
import { assertLedgerInvariant } from "../support/assertLedgerInvariant";
import {
	applyTransaction,
	openWalletWithOpening,
	openZeroWallet,
} from "../support/domain-builders";
import { uniqueId } from "../support/ids";
import { createPersistence, type Persistence } from "../support/persistence";
import {
	connect,
	insertLedgerEntry,
	insertTransaction,
	insertWallet,
} from "../support/sql";
import {
	createSuiteDatabase,
	type SuiteDatabase,
} from "../support/suite-database";

let db: SuiteDatabase;
let p: Persistence;
let sql: Client;

beforeAll(async () => {
	db = await createSuiteDatabase();
	p = await createPersistence(db.url);
	sql = await connect(db.url);
});

afterAll(async () => {
	await sql.end();
	await p.close();
	await db.drop();
});

const read = async (walletId: string) => {
	const report = await p.ledgerIntegrity.read(walletId);
	if (!report) throw new Error("wallet not found");
	return report;
};

/** A wallet row plus its ledger, written straight through SQL so a test can shape a broken state. */
async function sqlWallet(balance: string, version: number): Promise<string> {
	return (await insertWallet(sql, { balance, version })).id as string;
}
async function sqlEntry(
	walletId: string,
	overrides: Record<string, unknown>,
): Promise<void> {
	const tx = (await insertTransaction(sql, walletId)).id as string;
	await insertLedgerEntry(sql, walletId, tx, overrides);
}

describe("TST-I-14 ledger integrity reader: consistent wallets (PostgreSQL real)", () => {
	test("TST-I-14 a wallet built through the repositories is consistent, with the full report", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		await applyTransaction(p, wallet.id, WagerTransactionKind.Bet, "30.00");
		await applyTransaction(p, wallet.id, WagerTransactionKind.Win, "5.50");

		const report = await read(wallet.id);

		expect(report.storedBalance.toString()).toBe("75.50");
		expect(report.calculatedBalance.toString()).toBe("75.50");
		expect(report.difference.toString()).toBe("0.00");
		expect(report.storedBalance.currency).toBe("BRL");
		expect(report.checkedEntries).toBe(3);
		expect(report.chain).toEqual({
			continuous: true,
			firstBreakAtVersion: null,
		});
		expect(report.consistent).toBe(true);
		expect(report.walletVersion).toBe(3);
		expect(report.lastLedgerVersion).toBe(3);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-14 a wallet born at zero with no entries is consistent", async () => {
		const wallet = await openZeroWallet(p);

		const report = await read(wallet.id);

		expect(report.checkedEntries).toBe(0);
		expect(report.calculatedBalance.toString()).toBe("0.00");
		expect(report.lastLedgerVersion).toBeNull();
		expect(report.consistent).toBe(true);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-14 a wallet born at zero may start its chain at version 2", async () => {
		const wallet = await openZeroWallet(p);
		await applyTransaction(p, wallet.id, WagerTransactionKind.Win, "10.00");

		const report = await read(wallet.id);

		expect(report.walletVersion).toBe(2);
		expect(report.chain).toEqual({
			continuous: true,
			firstBreakAtVersion: null,
		});
		expect(report.consistent).toBe(true);
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	});

	test("TST-I-14 debits and credits are signed independently of the stored balance", async () => {
		const wallet = await openWalletWithOpening(p, "50.00");
		await applyTransaction(p, wallet.id, WagerTransactionKind.Bet, "20.00");
		await applyTransaction(p, wallet.id, WagerTransactionKind.Bet, "20.00");

		const report = await read(wallet.id);

		expect(report.calculatedBalance.toString()).toBe("10.00");
		expect(report.consistent).toBe(true);
	});

	test("TST-I-14 an unknown wallet has no report", async () => {
		expect(await p.ledgerIntegrity.read(uniqueId())).toBeUndefined();
		await expect(
			assertLedgerInvariant(p.ledgerIntegrity, uniqueId()),
		).rejects.toThrow(/does not exist/);
	});
});

describe("TST-I-14 ledger integrity reader: induced divergence", () => {
	test("TST-I-14 UPDATE wallets SET balance directly is flagged with the exact difference", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		await sql.query("update wallets set balance = '105.25' where id = $1", [
			wallet.id,
		]);

		const report = await read(wallet.id);

		expect(report.storedBalance.toString()).toBe("105.25");
		expect(report.calculatedBalance.toString()).toBe("100.00");
		expect(report.difference.toString()).toBe("5.25");
		expect(report.chain.continuous).toBe(true);
		expect(report.consistent).toBe(false);
		await expect(
			assertLedgerInvariant(p.ledgerIntegrity, wallet.id),
		).rejects.toThrow(
			/stored balance 105\.25 != ledger sum 100\.00 \(difference 5\.25\)/,
		);
	});

	test("TST-I-14 a stored balance below the ledger sum gives a negative difference", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		await sql.query("update wallets set balance = '40.00' where id = $1", [
			wallet.id,
		]);

		const report = await read(wallet.id);

		expect(report.difference.toString()).toBe("-60.00");
		expect(report.consistent).toBe(false);
	});

	test("TST-I-14 a chain break the sum cannot see is reported at the right version", async () => {
		// v1: 0 -> 100. v2 claims it started from 200 (respects the CHECKs), so the sum is still 110.
		const walletId = await sqlWallet("110.00", 2);
		await sqlEntry(walletId, {
			wallet_version: 1,
			balance_before: "0.00",
			balance_after: "100.00",
			amount: "100.00",
		});
		await sqlEntry(walletId, {
			wallet_version: 2,
			balance_before: "200.00",
			balance_after: "210.00",
			amount: "10.00",
		});

		const report = await read(walletId);

		expect(report.difference.toString()).toBe("0.00");
		expect(report.chain).toEqual({ continuous: false, firstBreakAtVersion: 2 });
		expect(report.consistent).toBe(false);
		await expect(
			assertLedgerInvariant(p.ledgerIntegrity, walletId),
		).rejects.toThrow(/chain broken at wallet_version 2/);
	});

	test("TST-I-14 reports the first break when there are several", async () => {
		const walletId = await sqlWallet("130.00", 4);
		await sqlEntry(walletId, {
			wallet_version: 1,
			balance_before: "0.00",
			balance_after: "100.00",
			amount: "100.00",
		});
		await sqlEntry(walletId, {
			wallet_version: 2,
			balance_before: "100.00",
			balance_after: "110.00",
			amount: "10.00",
		});
		await sqlEntry(walletId, {
			wallet_version: 3,
			balance_before: "500.00",
			balance_after: "510.00",
			amount: "10.00",
		});
		await sqlEntry(walletId, {
			wallet_version: 4,
			balance_before: "900.00",
			balance_after: "920.00",
			amount: "20.00",
		});

		expect((await read(walletId)).chain.firstBreakAtVersion).toBe(3);
	});

	test("TST-I-14 a hole in the versions breaks the chain at the version after the hole", async () => {
		const walletId = await sqlWallet("110.00", 3);
		await sqlEntry(walletId, {
			wallet_version: 1,
			balance_before: "0.00",
			balance_after: "100.00",
			amount: "100.00",
		});
		await sqlEntry(walletId, {
			wallet_version: 3,
			balance_before: "100.00",
			balance_after: "110.00",
			amount: "10.00",
		});

		const report = await read(walletId);

		expect(report.difference.toString()).toBe("0.00");
		expect(report.chain).toEqual({ continuous: false, firstBreakAtVersion: 3 });
		expect(report.consistent).toBe(false);
	});

	test("TST-I-14 a wallet with an initial balance requires the version 1 entry", async () => {
		const noEntries = await sqlWallet("100.00", 1);
		const missingFirst = await sqlWallet("110.00", 2);
		await sqlEntry(missingFirst, {
			wallet_version: 2,
			balance_before: "100.00",
			balance_after: "110.00",
			amount: "10.00",
		});

		const a = await read(noEntries);
		expect(a.difference.toString()).toBe("100.00");
		expect(a.checkedEntries).toBe(0);
		expect(a.consistent).toBe(false);

		const b = await read(missingFirst);
		expect(b.chain).toEqual({ continuous: false, firstBreakAtVersion: 2 });
		expect(b.consistent).toBe(false);
	});

	test("TST-I-14 wallets.version out of step with the last entry is a chain break and a version error", async () => {
		const ahead = await sqlWallet("100.00", 5);
		await sqlEntry(ahead, {
			wallet_version: 1,
			balance_before: "0.00",
			balance_after: "100.00",
			amount: "100.00",
		});
		const behind = await sqlWallet("110.00", 1);
		await sqlEntry(behind, {
			wallet_version: 1,
			balance_before: "0.00",
			balance_after: "100.00",
			amount: "100.00",
		});
		await sqlEntry(behind, {
			wallet_version: 2,
			balance_before: "100.00",
			balance_after: "110.00",
			amount: "10.00",
		});
		const noEntriesAhead = await sqlWallet("0.00", 3);

		const a = await read(ahead);
		expect(a.chain).toEqual({ continuous: false, firstBreakAtVersion: 2 });
		expect(a.walletVersion).toBe(5);
		await expect(
			assertLedgerInvariant(p.ledgerIntegrity, ahead),
		).rejects.toThrow(/wallets\.version 5 != last ledger version 1/);

		const b = await read(behind);
		expect(b.chain).toEqual({ continuous: false, firstBreakAtVersion: 2 });
		await expect(
			assertLedgerInvariant(p.ledgerIntegrity, behind),
		).rejects.toThrow(/wallets\.version 1 != last ledger version 2/);

		const c = await read(noEntriesAhead);
		expect(c.chain).toEqual({ continuous: false, firstBreakAtVersion: 2 });
	});
});

describe("TST-I-14 ledger integrity reader: one snapshot, no locks", () => {
	test("TST-I-14 repeated reads during concurrent writes never report a false divergence", async () => {
		const wallet = await openWalletWithOpening(p, "1000.00");
		const writer = await createPersistence(db.url);
		try {
			let writing = true;
			const writes = (async () => {
				try {
					for (let i = 0; i < 60; i++) {
						await applyTransaction(
							writer,
							wallet.id,
							i % 3 === 0 ? WagerTransactionKind.Win : WagerTransactionKind.Bet,
							"1.00",
						);
					}
				} finally {
					writing = false;
				}
			})();

			const seen = new Set<number>();
			const bad: string[] = [];
			const reads = (async () => {
				while (writing) {
					const report = await read(wallet.id);
					seen.add(report.checkedEntries);
					if (!report.consistent) {
						bad.push(
							`${report.checkedEntries} entries: stored ${report.storedBalance} vs ${report.calculatedBalance}, break ${report.chain.firstBreakAtVersion}`,
						);
					}
				}
			})();
			await Promise.all([writes, reads]);

			expect(bad).toEqual([]);
			// The reader really overlapped the writer: it observed several distinct states.
			expect(seen.size).toBeGreaterThan(3);
			await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
			expect((await read(wallet.id)).checkedEntries).toBe(61);
		} finally {
			await writer.close();
		}
	});

	test("TST-I-14 reading takes no lock: a held FOR UPDATE does not block the reader", async () => {
		const wallet = await openWalletWithOpening(p, "10.00");
		let release!: () => void;
		const hold = new Promise<void>((r) => {
			release = r;
		});
		let locked!: () => void;
		const isLocked = new Promise<void>((r) => {
			locked = r;
		});
		const holder = p.tm.run(async () => {
			await p.wallets.findByIdForUpdate(wallet.id);
			locked();
			await hold;
		});
		await isLocked;

		const short = await createPersistence(db.url, {
			lockTimeoutMs: 100,
			statementTimeoutMs: 1000,
		});
		try {
			const report = await Promise.race([
				short.ledgerIntegrity.read(wallet.id),
				new Promise<string>((r) => setTimeout(() => r("blocked"), 2000)),
			]);
			expect(report).not.toBe("blocked");
		} finally {
			release();
			await holder;
			await short.close();
		}
	});
});
