import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { assertLedgerInvariant } from "../support/assertLedgerInvariant";
import {
	type HttpApp,
	startHttpApp,
	type TestWallet,
} from "../support/http-app";
import { uniqueId } from "../support/ids";
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
const touched: TestWallet[] = [];

beforeAll(async () => {
	db = await createSuiteDatabase();
	api = await startHttpApp(db);
	sql = await connect(db.url);
	p = await createPersistence(db.url);
});

afterAll(async () => {
	for (const wallet of touched) {
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	}
	await p.close();
	await sql.end();
	await api.stop();
	await db.drop();
});

async function wallet(balance: string): Promise<TestWallet> {
	const created = await api.createWallet(balance);
	touched.push(created);
	return created;
}

const cursorOf = (text: string) =>
	Buffer.from(text, "utf8").toString("base64url");

/** `count` BETs of 1.00 through the API, `width` at a time (versions 2..count+1, in any order of arrival). */
async function placeBets(w: TestWallet, count: number, width = 8) {
	for (let done = 0; done < count; done += width) {
		const batch = Math.min(width, count - done);
		const replies = await Promise.all(
			Array.from({ length: batch }, () => api.submit(w, "1.00")),
		);
		for (const reply of replies) expect(reply.status).toBe(201);
	}
}

describe("T-034 transaction queries", () => {
	test("T-034 by id returns the current state with the identifiers", async () => {
		const w = await wallet("100.00");
		const submission = api.buildSubmit(w, "30.00");
		const created = await api.request(
			"POST",
			"/wagering/transactions",
			submission,
		);

		const reply = await api.request(
			"GET",
			`/wagering/transactions/${created.body.transactionId}`,
		);

		expect(reply.status).toBe(200);
		expect(reply.body).toEqual({
			transactionId: created.body.transactionId,
			id: created.body.transactionId,
			status: "PROCESSED",
			balance: { amount: "70.00", currency: "BRL" },
			failureCode: null,
			idempotentReplay: false,
			providerId: "provider-a",
			externalTransactionId: submission.body.externalTransactionId,
			walletId: w.id,
			kind: "BET",
			money: { amount: "30.00", currency: "BRL" },
			referenceTransactionId: null,
			createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
			processedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
		});
	});

	test("T-034 by provider and external id returns the same state", async () => {
		const w = await wallet("100.00");
		const submission = api.buildSubmit(w, "30.00", { providerId: "casino-x" });
		const created = await api.request(
			"POST",
			"/wagering/transactions",
			submission,
		);

		const reply = await api.request(
			"GET",
			`/providers/casino-x/wagering/transactions/${submission.body.externalTransactionId}`,
		);

		expect(reply.status).toBe(200);
		expect(reply.body.transactionId).toBe(created.body.transactionId);
		expect(reply.body.providerId).toBe("casino-x");
	});

	test("T-034 a REJECTED shows its failureCode and a reversal shows the resolved reference", async () => {
		const w = await wallet("10.00");
		const rejected = await api.submit(w, "50.00");
		const bet = api.buildSubmit(w, "4.00");
		const placed = await api.request("POST", "/wagering/transactions", bet);
		const refund = await api.submit(w, "4.00", {
			kind: "REFUND",
			reference: bet.body.externalTransactionId,
		});

		const a = await api.request(
			"GET",
			`/wagering/transactions/${rejected.body.transactionId}`,
		);
		const b = await api.request(
			"GET",
			`/wagering/transactions/${refund.body.transactionId}`,
		);

		expect(a.body).toMatchObject({
			status: "REJECTED",
			failureCode: "INSUFFICIENT_FUNDS",
			processedAt: null,
		});
		expect(b.body).toMatchObject({
			status: "PROCESSED",
			kind: "REFUND",
			referenceTransactionId: placed.body.transactionId,
		});
	});

	test("T-034 a PENDING_REFERENCE is visible as such", async () => {
		const w = await wallet("10.00");
		const pending = await api.submit(w, "5.00", {
			kind: "WIN",
			reference: `later-${uniqueId()}`,
		});

		const reply = await api.request(
			"GET",
			`/wagering/transactions/${pending.body.transactionId}`,
		);

		expect(reply.status).toBe(200);
		expect(reply.body).toMatchObject({
			status: "PENDING_REFERENCE",
			failureCode: null,
			processedAt: null,
		});
	});

	test("T-034 unknown transaction is 404 TRANSACTION_NOT_FOUND on both routes", async () => {
		const byId = await api.request(
			"GET",
			`/wagering/transactions/${uniqueId()}`,
		);
		const byExternal = await api.request(
			"GET",
			`/providers/casino-x/wagering/transactions/nope-${uniqueId()}`,
		);

		for (const reply of [byId, byExternal]) {
			expect(reply.status).toBe(404);
			expect(reply.headers.get("content-type")).toContain(
				"application/problem+json",
			);
			expect(reply.body.errorCode).toBe("TRANSACTION_NOT_FOUND");
		}
	});

	test("T-034 a transaction id that is not a UUID is 400 VALIDATION_ERROR", async () => {
		const reply = await api.request("GET", "/wagering/transactions/not-a-uuid");
		expect(reply.status).toBe(400);
		expect(reply.body.errorCode).toBe("VALIDATION_ERROR");
	});

	test("T-034 the external id is looked up inside its provider only", async () => {
		const w = await wallet("100.00");
		const submission = api.buildSubmit(w, "5.00", { providerId: "casino-x" });
		await api.request("POST", "/wagering/transactions", submission);

		const reply = await api.request(
			"GET",
			`/providers/casino-y/wagering/transactions/${submission.body.externalTransactionId}`,
		);

		expect(reply.status).toBe(404);
	});
});

describe("TST-I-15 ledger pagination", () => {
	test("TST-I-15 pages walk the whole ledger newest first, without repeating or skipping", async () => {
		const w = await wallet("100.00");
		await placeBets(w, 24); // versions 1 (opening) .. 25

		const seen: number[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const reply = await api.request(
				"GET",
				`/wallets/${w.id}/ledger?limit=10${cursor === null ? "" : `&cursor=${cursor}`}`,
			);
			expect(reply.status).toBe(200);
			expect(Object.keys(reply.body).sort()).toEqual(["items", "nextCursor"]);
			seen.push(
				...reply.body.items.map(
					(i: { walletVersion: number }) => i.walletVersion,
				),
			);
			cursor = reply.body.nextCursor;
			pages += 1;
		} while (cursor !== null);

		expect(pages).toBe(3);
		expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => 25 - i));
	});

	test("TST-I-15 an item carries id, transactionId, version, direction, money and the balance chain", async () => {
		const w = await wallet("100.00");
		await api.submit(w, "30.00");

		const reply = await api.request("GET", `/wallets/${w.id}/ledger`);

		expect(reply.body.nextCursor).toBeNull();
		expect(reply.body.items).toHaveLength(2);
		expect(reply.body.items[0]).toEqual({
			id: expect.stringMatching(/^[0-9a-f-]{36}$/),
			transactionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			walletVersion: 2,
			direction: "DEBIT",
			money: { amount: "30.00", currency: "BRL" },
			balanceBefore: { amount: "100.00", currency: "BRL" },
			balanceAfter: { amount: "70.00", currency: "BRL" },
			createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
		});
		expect(reply.body.items[1]).toMatchObject({
			walletVersion: 1,
			direction: "CREDIT",
			balanceBefore: { amount: "0.00", currency: "BRL" },
			balanceAfter: { amount: "100.00", currency: "BRL" },
		});
	});

	test("TST-I-15 the default limit is 50 and the maximum is 200", async () => {
		const w = await wallet("1000.00");
		await placeBets(w, 209, 10); // 210 entries

		const byDefault = await api.request("GET", `/wallets/${w.id}/ledger`);
		const max = await api.request("GET", `/wallets/${w.id}/ledger?limit=200`);
		const one = await api.request("GET", `/wallets/${w.id}/ledger?limit=1`);
		const rest = await api.request(
			"GET",
			`/wallets/${w.id}/ledger?limit=200&cursor=${max.body.nextCursor}`,
		);

		expect(byDefault.body.items).toHaveLength(50);
		expect(byDefault.body.nextCursor).not.toBeNull();
		expect(max.body.items).toHaveLength(200);
		expect(max.body.items[0].walletVersion).toBe(210);
		expect(max.body.items[199].walletVersion).toBe(11);
		expect(one.body.items).toHaveLength(1);
		expect(rest.body.items).toHaveLength(10);
		expect(rest.body.nextCursor).toBeNull();
	}, 30_000);

	test("TST-I-15 the last page has nextCursor null even when it is exactly full", async () => {
		const w = await wallet("100.00");
		await placeBets(w, 9); // 10 entries

		const exact = await api.request("GET", `/wallets/${w.id}/ledger?limit=10`);
		const split = await api.request("GET", `/wallets/${w.id}/ledger?limit=5`);

		expect(exact.body.items).toHaveLength(10);
		expect(exact.body.nextCursor).toBeNull();
		expect(split.body.nextCursor).not.toBeNull();
	});

	test.each(["0", "201", "-1", "abc", "1.5", "", "1e2"])(
		"TST-I-15 limit=%p is 400 VALIDATION_ERROR",
		async (limit) => {
			const w = await wallet("100.00");

			const reply = await api.request(
				"GET",
				`/wallets/${w.id}/ledger?limit=${limit}`,
			);

			expect(reply.status).toBe(400);
			expect(reply.headers.get("content-type")).toContain(
				"application/problem+json",
			);
			expect(reply.body.errorCode).toBe("VALIDATION_ERROR");
		},
	);

	test.each([
		["garbage", "!!!not-base64!!!"],
		["base64url of a non-number", cursorOf("abc")],
		["base64url of a negative number", cursorOf("-3")],
		["base64url of zero", cursorOf("0")],
		["base64url of a decimal", cursorOf("1.5")],
		["base64url of a number beyond int32", cursorOf("99999999999")],
		["base64url of a number with leading zeros", cursorOf("007")],
		["padded base64", `${cursorOf("12")}==`],
	])("TST-I-15 cursor %s is 400 INVALID_CURSOR", async (_name, cursor) => {
		const w = await wallet("100.00");

		const reply = await api.request(
			"GET",
			`/wallets/${w.id}/ledger?cursor=${encodeURIComponent(cursor)}`,
		);

		expect(reply.status).toBe(400);
		expect(reply.body.errorCode).toBe("INVALID_CURSOR");
		expect(reply.body.retryable).toBe(false);
	});

	test("TST-I-15 a valid cursor below the first version yields an empty last page", async () => {
		const w = await wallet("100.00");

		const reply = await api.request(
			"GET",
			`/wallets/${w.id}/ledger?cursor=${cursorOf("1")}`,
		);

		expect(reply.status).toBe(200);
		expect(reply.body).toEqual({ items: [], nextCursor: null });
	});

	test("TST-I-15 unknown wallet is 404 WALLET_NOT_FOUND", async () => {
		const reply = await api.request("GET", `/wallets/${uniqueId()}/ledger`);
		expect(reply.status).toBe(404);
		expect(reply.body.errorCode).toBe("WALLET_NOT_FOUND");
	});

	test("TST-I-15 a wallet with a zero opening balance has an empty ledger", async () => {
		const w = await wallet("0.00");
		const reply = await api.request("GET", `/wallets/${w.id}/ledger`);
		expect(reply.body).toEqual({ items: [], nextCursor: null });
	});

	test("TST-I-15 the cursor is stable under concurrent inserts: nothing repeats, nothing from the walked snapshot is lost", async () => {
		const w = await wallet("500.00");
		await placeBets(w, 39); // versions 1..40
		const seen: number[] = [];

		const first = await api.request("GET", `/wallets/${w.id}/ledger?limit=10`);
		seen.push(
			...first.body.items.map(
				(i: { walletVersion: number }) => i.walletVersion,
			),
		);
		let cursor: string | null = first.body.nextCursor;
		let step = 0;
		while (cursor !== null) {
			// Another connection appends while the client is between pages.
			await placeBets(w, 3, 3);
			const reply = await api.request(
				"GET",
				`/wallets/${w.id}/ledger?limit=10&cursor=${cursor}`,
			);
			seen.push(
				...reply.body.items.map(
					(i: { walletVersion: number }) => i.walletVersion,
				),
			);
			cursor = reply.body.nextCursor;
			step += 1;
		}

		expect(step).toBe(3);
		expect(new Set(seen).size).toBe(seen.length);
		expect(seen).toEqual(Array.from({ length: 40 }, (_, i) => 40 - i));
		const fresh = await api.request("GET", `/wallets/${w.id}/ledger?limit=1`);
		expect(fresh.body.items[0].walletVersion).toBe(49);
	});
});
