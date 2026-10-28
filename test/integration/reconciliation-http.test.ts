import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { assertLedgerInvariant } from "../support/assertLedgerInvariant";
import { eventually } from "../support/eventually";
import {
	type HttpApp,
	startHttpApp,
	type TestWallet,
} from "../support/http-app";
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
let api: HttpApp;
let sql: Client;
let p: Persistence;
const healthy: TestWallet[] = [];

beforeAll(async () => {
	db = await createSuiteDatabase();
	api = await startHttpApp(db);
	sql = await connect(db.url);
	p = await createPersistence(db.url);
});

afterAll(async () => {
	// Only the wallets nobody tampered with must still satisfy the invariant.
	for (const wallet of healthy) {
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	}
	await p.close();
	await sql.end();
	await api.stop();
	await db.drop();
});

const reconcile = (walletId: string) =>
	api.request("POST", `/wallets/${walletId}/reconciliation`);
const divergences = () => api.metric("reconciliation_divergences_total");

async function healthyWallet(balance: string): Promise<TestWallet> {
	const created = await api.createWallet(balance);
	healthy.push(created);
	return created;
}

/** A wallet written straight through SQL, so the test shapes the ledger it wants. */
async function sqlWallet(
	balance: string,
	version: number,
	entries: Array<Record<string, unknown>>,
): Promise<string> {
	const id = (await insertWallet(sql, { balance, version })).id as string;
	for (const entry of entries) {
		const tx = (await insertTransaction(sql, id)).id as string;
		await insertLedgerEntry(sql, id, tx, entry);
	}
	return id;
}

const jsonLines = () =>
	api.process
		.stdout()
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line) as Record<string, unknown>);

describe("TST-I-14 reconciliation endpoint (real PostgreSQL)", () => {
	test("TST-I-14 a consistent wallet answers 200 with the full report and no divergence", async () => {
		const w = await healthyWallet("100.00");
		await api.submit(w, "30.00");
		await api.submit(w, "5.50", { kind: "WIN" });
		const before = await divergences();

		const reply = await reconcile(w.id);

		expect(reply.status).toBe(200);
		expect(reply.body).toEqual({
			walletId: w.id,
			storedBalance: { amount: "75.50", currency: "BRL" },
			calculatedBalance: { amount: "75.50", currency: "BRL" },
			difference: { amount: "0.00", currency: "BRL" },
			consistent: true,
			checkedEntries: 3,
			chain: { continuous: true, firstBreakAtVersion: null },
		});
		expect(await divergences()).toBe(before);
	});

	test("TST-I-14 a wallet born at zero with no entries is consistent", async () => {
		const w = await healthyWallet("0.00");

		const reply = await reconcile(w.id);

		expect(reply.status).toBe(200);
		expect(reply.body).toMatchObject({
			consistent: true,
			checkedEntries: 0,
			chain: { continuous: true, firstBreakAtVersion: null },
		});
	});

	test("TST-I-14 an induced balance divergence: consistent false, exact difference, metric, error log without values, nothing corrected", async () => {
		const w = await api.createWallet("100.00");
		await api.submit(w, "30.00"); // ledger says 70.00
		await sql.query("update wallets set balance = '77.77' where id = $1", [
			w.id,
		]);
		const before = await divergences();

		const reply = await reconcile(w.id);

		expect(reply.status).toBe(200);
		expect(reply.body).toEqual({
			walletId: w.id,
			storedBalance: { amount: "77.77", currency: "BRL" },
			calculatedBalance: { amount: "70.00", currency: "BRL" },
			difference: { amount: "7.77", currency: "BRL" },
			consistent: false,
			checkedEntries: 2,
			chain: { continuous: true, firstBreakAtVersion: null },
		});
		expect(await divergences()).toBe(before + 1);
		const line = await eventually(
			() =>
				jsonLines().find(
					(l) =>
						l.level === 50 &&
						l.msg === "reconciliation divergence detected" &&
						l.walletId === w.id,
				) ?? false,
		);
		expect(line).toMatchObject({
			walletId: w.id,
			reason: "balance_mismatch",
		});
		// Never corrected: the tampered value is still there.
		const stored = await sql.query(
			"select balance from wallets where id = $1",
			[w.id],
		);
		expect(stored.rows[0].balance).toBe("77.77");
		// Values never reach the logs.
		const raw = api.process.stdout();
		for (const forbidden of ["77.77", "70.00", "7.77", w.playerId]) {
			expect(raw).not.toContain(forbidden);
		}
	});

	test("TST-I-14 a broken chain is detected even when the sum matches", async () => {
		const id = await sqlWallet("110.00", 2, [
			{
				wallet_version: 1,
				direction: "CREDIT",
				amount: "100.00",
				balance_before: "0.00",
				balance_after: "100.00",
			},
			{
				wallet_version: 2,
				direction: "CREDIT",
				amount: "10.00",
				balance_before: "90.00",
				balance_after: "100.00",
			},
		]);
		const before = await divergences();

		const reply = await reconcile(id);

		expect(reply.status).toBe(200);
		expect(reply.body).toMatchObject({
			consistent: false,
			difference: { amount: "0.00", currency: "BRL" },
			checkedEntries: 2,
			chain: { continuous: false, firstBreakAtVersion: 2 },
		});
		expect(await divergences()).toBe(before + 1);
		const line = await eventually(
			() =>
				jsonLines().find(
					(l) =>
						l.level === 50 &&
						l.msg === "reconciliation divergence detected" &&
						l.walletId === id,
				) ?? false,
		);
		expect(line).toMatchObject({
			reason: "chain_broken",
			firstBreakAtVersion: 2,
		});
	});

	test("TST-I-14 a hole in the versions is detected", async () => {
		const id = await sqlWallet("110.00", 3, [
			{
				wallet_version: 1,
				direction: "CREDIT",
				amount: "100.00",
				balance_before: "0.00",
				balance_after: "100.00",
			},
			{
				wallet_version: 3,
				direction: "CREDIT",
				amount: "10.00",
				balance_before: "100.00",
				balance_after: "110.00",
			},
		]);

		const reply = await reconcile(id);

		expect(reply.body).toMatchObject({
			consistent: false,
			chain: { continuous: false, firstBreakAtVersion: 3 },
		});
	});

	test("TST-I-14 a wallet whose version is ahead of its ledger is inconsistent", async () => {
		const id = await sqlWallet("100.00", 5, [
			{
				wallet_version: 1,
				direction: "CREDIT",
				amount: "100.00",
				balance_before: "0.00",
				balance_after: "100.00",
			},
		]);

		const reply = await reconcile(id);

		expect(reply.body.consistent).toBe(false);
		expect(reply.body.chain.continuous).toBe(false);
	});

	test("TST-I-14 a divergence with a broken chain logs both reasons", async () => {
		const id = await sqlWallet("500.00", 2, [
			{
				wallet_version: 1,
				direction: "CREDIT",
				amount: "100.00",
				balance_before: "0.00",
				balance_after: "100.00",
			},
			{
				wallet_version: 2,
				direction: "CREDIT",
				amount: "10.00",
				balance_before: "90.00",
				balance_after: "100.00",
			},
		]);

		await reconcile(id);

		const line = await eventually(
			() =>
				jsonLines().find(
					(l) =>
						l.msg === "reconciliation divergence detected" && l.walletId === id,
				) ?? false,
		);
		expect(line).toMatchObject({
			reason: "balance_mismatch_and_chain_broken",
			firstBreakAtVersion: 2,
		});
	});

	test("TST-I-14 reads one snapshot: reconciling during concurrent writes never reports a false divergence", async () => {
		const w = await healthyWallet("1000.00");
		const before = await divergences();

		const [reports] = await Promise.all([
			Promise.all(Array.from({ length: 40 }, () => reconcile(w.id))),
			Promise.all(Array.from({ length: 40 }, () => api.submit(w, "1.00"))),
		]);

		for (const report of reports) {
			expect(report.status).toBe(200);
			expect(report.body.consistent).toBe(true);
			expect(report.body.chain.continuous).toBe(true);
		}
		expect(await divergences()).toBe(before);
	});

	test("TST-I-14 takes no lock: a wallet locked FOR UPDATE by another connection is still reconciled", async () => {
		const w = await healthyWallet("100.00");
		const holder = await connect(db.url);
		await holder.query("begin");
		await holder.query("select id from wallets where id = $1 for update", [
			w.id,
		]);
		let reply: Awaited<ReturnType<typeof reconcile>> | "blocked";
		try {
			// If the endpoint waited for the lock, this would sit here until the guard fires.
			reply = await Promise.race([
				reconcile(w.id),
				new Promise<"blocked">((resolve) =>
					setTimeout(() => resolve("blocked"), 5000),
				),
			]);
		} finally {
			await holder.query("rollback");
			await holder.end();
		}

		expect(reply).not.toBe("blocked");
		if (reply === "blocked") return;
		expect(reply.status).toBe(200);
		expect(reply.body.consistent).toBe(true);
	});

	test("TST-I-14 unknown wallet is 404 WALLET_NOT_FOUND and a malformed id is 400", async () => {
		const missing = await reconcile(uniqueId());
		const malformed = await reconcile("not-a-uuid");

		expect(missing.status).toBe(404);
		expect(missing.body.errorCode).toBe("WALLET_NOT_FOUND");
		expect(malformed.status).toBe(400);
		expect(malformed.body.errorCode).toBe("VALIDATION_ERROR");
	});
});
