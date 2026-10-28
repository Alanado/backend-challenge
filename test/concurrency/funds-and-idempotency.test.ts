import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import {
	assertWalletsConsistent,
	deadlocksOf,
	expectNoServerError,
	ledgerRows,
	statusesOf,
} from "../support/concurrency";
import { type HttpApp, startHttpApp } from "../support/http-app";
import { createPersistence, type Persistence } from "../support/persistence";
import { connect } from "../support/sql";
import {
	createSuiteDatabase,
	type SuiteDatabase,
} from "../support/suite-database";

let db: SuiteDatabase;
let api: HttpApp;
let sql: Client;
let p: Persistence;

beforeAll(async () => {
	db = await createSuiteDatabase();
	// Pool of 10 (the default): the limit under test is the lock queue, not the pool. LOCK_TIMEOUT_MS
	// is raised so that 200 requests queued behind one wallet lock never hit it by waiting alone.
	api = await startHttpApp(db, {
		env: { DB_POOL_MAX: "10", LOCK_TIMEOUT_MS: "30000" },
	});
	sql = await connect(db.url);
	p = await createPersistence(db.url);
});

afterAll(async () => {
	const deadlocks = await deadlocksOf(sql);
	await p.close();
	await sql.end();
	await api.stop();
	await db.drop();
	expect(deadlocks).toBe(0);
});

describe("TST-C-01 (HTTP half) the same BET 50 times in parallel", () => {
	test("TST-C-01 exactly one 201, 49 replays with idempotentReplay, one debit, one transactionId", async () => {
		const w = await api.createWallet("100.00");
		const { body, headers } = api.buildSubmit(w, "30.00");
		const replaysBefore = await api.metric("idempotent_requests_total", {
			outcome: "replay",
		});

		const replies = await Promise.all(
			Array.from({ length: 50 }, () =>
				api.request("POST", "/wagering/transactions", { body, headers }),
			),
		);

		expectNoServerError(replies);
		const statuses = statusesOf(replies);
		expect(statuses.filter((s) => s === 201)).toHaveLength(1);
		expect(statuses.filter((s) => s === 200)).toHaveLength(49);
		const created = replies.filter((r) => r.status === 201);
		expect(created[0]?.body.idempotentReplay).toBe(false);
		for (const reply of replies.filter((r) => r.status === 200)) {
			expect(reply.body.idempotentReplay).toBe(true);
			expect(reply.body.status).toBe("PROCESSED");
			expect(reply.body.balance).toEqual({ amount: "70.00", currency: "BRL" });
		}
		expect(new Set(replies.map((r) => r.body.transactionId)).size).toBe(1);
		const ledger = await ledgerRows(sql, w.id);
		expect(ledger.filter((e) => e.direction === "DEBIT")).toHaveLength(1);
		expect(await api.balanceOf(w)).toBe("70.00");
		const transactions = await sql.query(
			"select count(*)::int as n from wager_transactions where wallet_id = $1 and kind = 'BET'",
			[w.id],
		);
		expect(transactions.rows[0].n).toBe(1);
		expect(
			await api.metric("idempotent_requests_total", { outcome: "replay" }),
		).toBe(replaysBefore + 49);
		await assertWalletsConsistent(p, [w]);
	});
});

describe("TST-C-02 two BETs of 80.00 against 100.00", () => {
	test("TST-C-02 per round: one PROCESSED, one REJECTED INSUFFICIENT_FUNDS, balance 20.00, one DEBIT, no 5xx (20 rounds)", async () => {
		const wallets = [];
		for (let round = 0; round < 20; round++) {
			const w = await api.createWallet("100.00");
			wallets.push(w);

			const replies = await Promise.all([
				api.submit(w, "80.00"),
				api.submit(w, "80.00"),
			]);

			expectNoServerError(replies);
			expect(statusesOf(replies).sort()).toEqual([201, 422]);
			const rejected = replies.find((r) => r.status === 422);
			expect(rejected?.body).toMatchObject({
				status: "REJECTED",
				failureCode: "INSUFFICIENT_FUNDS",
			});
			expect(await api.balanceOf(w)).toBe("20.00");
			const debits = (await ledgerRows(sql, w.id)).filter(
				(e) => e.direction === "DEBIT",
			);
			expect(debits).toHaveLength(1);
		}
		await assertWalletsConsistent(p, wallets);
	});

	test("TST-C-02 the same, 25 wallets racing at once", async () => {
		const wallets = await Promise.all(
			Array.from({ length: 25 }, () => api.createWallet("100.00")),
		);

		const replies = await Promise.all(
			wallets.flatMap((w) => [api.submit(w, "80.00"), api.submit(w, "80.00")]),
		);

		expectNoServerError(replies);
		for (let i = 0; i < wallets.length; i++) {
			const pair = [replies[2 * i], replies[2 * i + 1]];
			expect(statusesOf(pair.filter((r) => r !== undefined)).sort()).toEqual([
				201, 422,
			]);
		}
		for (const w of wallets) expect(await api.balanceOf(w)).toBe("20.00");
		await assertWalletsConsistent(p, wallets);
	});
});

describe("TST-C-12 hot wallet", () => {
	test("TST-C-12 100.00 and 200 BETs of 1.00 at once: 100 PROCESSED, 100 REJECTED, balance 0.00, versions 2..101, no 5xx", async () => {
		const w = await api.createWallet("100.00");

		const replies = await Promise.all(
			Array.from({ length: 200 }, () => api.submit(w, "1.00")),
		);

		expectNoServerError(replies);
		const statuses = statusesOf(replies);
		expect(statuses.filter((s) => s === 201)).toHaveLength(100);
		expect(statuses.filter((s) => s === 422)).toHaveLength(100);
		for (const reply of replies.filter((r) => r.status === 422)) {
			expect(reply.body.failureCode).toBe("INSUFFICIENT_FUNDS");
		}
		expect(await api.balanceOf(w)).toBe("0.00");
		const ledger = await ledgerRows(sql, w.id);
		const debits = ledger.filter((e) => e.direction === "DEBIT");
		expect(debits).toHaveLength(100);
		expect(debits.map((e) => e.wallet_version)).toEqual(
			Array.from({ length: 100 }, (_, i) => i + 2),
		);
		expect(debits[99]?.balance_after).toBe("0.00");
		// every accepted amount is distinct work: 100 distinct transactions
		expect(new Set(debits.map((e) => e.transaction_id)).size).toBe(100);
		const version = await sql.query(
			"select version from wallets where id = $1",
			[w.id],
		);
		expect(version.rows[0].version).toBe(101);
		await assertWalletsConsistent(p, [w]);
	});
});
