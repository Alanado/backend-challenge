import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runStrategy, type Strategy } from "../load/lib/strategies";
import { createPersistence, type Persistence } from "../support/persistence";
import {
	createSuiteDatabase,
	type SuiteDatabase,
} from "../support/suite-database";

let db: SuiteDatabase;
let p: Persistence;

beforeAll(async () => {
	db = await createSuiteDatabase();
	p = await createPersistence(db.url);
});

afterAll(async () => {
	await p.close();
	await db.drop();
});

describe("TST-I-23 strategies A (FOR UPDATE) and C (conditional UPDATE), 50 clients on one wallet (real PostgreSQL)", () => {
	for (const strategy of ["A", "C"] as const satisfies readonly Strategy[]) {
		test(`TST-I-23 strategy ${strategy}: balance = initial - accepted debits, never negative, one ledger entry per accepted debit`, async () => {
			const result = await runStrategy(
				strategy,
				{
					url: db.url,
					clients: 50,
					attemptsPerClient: 6,
					amount: "1.00",
					fundedPercent: 60,
				},
				p,
			);
			expect(result.violations).toEqual([]);
			// 300 attempts, funds for 180: exactly 180 accepted and 120 rejected for funds.
			expect(result.accepted).toBe(180);
			expect(result.rejected).toBe(120);
			expect(result.initialBalance).toBe("180.00");
			expect(result.finalBalance).toBe("0.00");
			expect(result.ledgerDebits).toBe(result.accepted);
			expect(result.processedRows).toBe(result.accepted);
			expect(result.rejectedRows).toBe(result.rejected);
			// The version guard is an assertion that must never fire; nothing else may fail either.
			expect(result.versionConflicts).toBe(0);
			expect(result.deadlocks).toBe(0);
			expect(result.otherErrors).toBe(0);
			expect(result.accepted + result.rejected + result.lockTimeouts).toBe(
				result.attempts,
			);
		}, 60_000);
	}
});
