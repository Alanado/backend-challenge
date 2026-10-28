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

beforeAll(async () => {
	db = await createSuiteDatabase();
	// A long lock_timeout: the request parked behind the held lock must stay parked (not 503) for
	// as long as the test needs, so that "wallet B kept going" is the only thing being measured.
	api = await startHttpApp(db, {
		env: { DB_POOL_MAX: "10", LOCK_TIMEOUT_MS: "60000" },
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

/** Resolves with the value, or with `"stuck"` if it has not settled within `ms` (a guard, never a sync point). */
function within<T>(promise: Promise<T>, ms: number): Promise<T | "stuck"> {
	return Promise.race([
		promise,
		new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), ms)),
	]);
}

describe("TST-C-03 no global lock between wallets", () => {
	test("TST-C-03 with wallet A locked FOR UPDATE, BETs on wallet B succeed while A's request waits; releasing A completes it", async () => {
		const a = await api.createWallet("100.00");
		const b = await api.createWallet("100.00");
		const holder = await connect(db.url);
		await holder.query("begin");
		await holder.query("select id from wallets where id = $1 for update", [
			a.id,
		]);
		let pendingA: ReturnType<typeof api.submit> | undefined;
		let aSettled = false;
		try {
			pendingA = api.submit(a, "10.00");
			void pendingA.then(() => {
				aSettled = true;
			});

			// Sequential and parallel traffic on B, all while A is held. Had any lock been shared,
			// these would sit behind A's holder and the guard would fire.
			const sequential: number[] = [];
			for (let i = 0; i < 5; i++) {
				const reply = await within(api.submit(b, "1.00"), 5000);
				expect(reply).not.toBe("stuck");
				if (reply !== "stuck") sequential.push(reply.status);
			}
			const parallel = await within(
				Promise.all(Array.from({ length: 10 }, () => api.submit(b, "1.00"))),
				5000,
			);
			expect(parallel).not.toBe("stuck");

			expect(sequential).toEqual([201, 201, 201, 201, 201]);
			if (parallel !== "stuck") {
				expect(statusesOf(parallel)).toEqual(Array(10).fill(201));
			}
			expect(aSettled).toBe(false);
			expect(await api.balanceOf(b)).toBe("85.00");
		} finally {
			await holder.query("rollback");
			await holder.end();
		}

		const released = await pendingA;
		expect(released?.status).toBe(201);
		expect(await api.balanceOf(a)).toBe("90.00");
		await assertWalletsConsistent(p, [a, b]);
	}, 60_000);

	test("TST-C-03 30 wallets in parallel, 5 BETs each, every one ends correct", async () => {
		const wallets = await Promise.all(
			Array.from({ length: 30 }, () => api.createWallet("100.00")),
		);

		const replies = await Promise.all(
			wallets.flatMap((w) =>
				Array.from({ length: 5 }, () => api.submit(w, "10.00")),
			),
		);

		expectNoServerError(replies);
		expect(statusesOf(replies)).toEqual(Array(150).fill(201));
		for (const w of wallets) expect(await api.balanceOf(w)).toBe("50.00");
		await assertWalletsConsistent(p, wallets);
	});
});

describe("TST-C-09 same external id on different wallets, different keys", () => {
	async function round(): Promise<{ statuses: number[]; codes: unknown[] }> {
		const [w1, w2] = await Promise.all([
			api.createWallet("100.00"),
			api.createWallet("100.00"),
		]);
		const externalTransactionId = `shared-${uniqueId()}`;
		const replies = await Promise.all([
			api.submit(w1, "10.00", {
				externalTransactionId,
				key: `k1-${uniqueId()}`,
			}),
			api.submit(w2, "10.00", {
				externalTransactionId,
				key: `k2-${uniqueId()}`,
			}),
		]);
		expectNoServerError(replies);
		const loser = replies.find((r) => r.status === 409);
		const winner = replies.find((r) => r.status === 201);
		expect(winner).toBeDefined();
		expect(loser?.body.errorCode).toBe("EXTERNAL_TRANSACTION_ID_CONFLICT");
		// Only the winner moved money, and only once.
		const debited = (
			await Promise.all([w1, w2].map((w) => api.balanceOf(w)))
		).filter((balance) => balance === "90.00");
		expect(debited).toHaveLength(1);
		await assertWalletsConsistent(p, [w1, w2]);
		return {
			statuses: statusesOf(replies),
			codes: replies.map((r) => r.body.errorCode),
		};
	}

	test("TST-C-09 one wins (201), the other is 409; zero deadlocks, zero 503 (40 rounds)", async () => {
		const deadlocksBefore = await deadlocksOf(sql);
		const conflictsBefore = await api.metric("lock_conflicts_total", {
			type: "deadlock",
		});

		for (let i = 0; i < 40; i++) {
			const { statuses } = await round();
			expect(statuses.sort()).toEqual([201, 409]);
		}

		expect(await api.metric("lock_conflicts_total", { type: "deadlock" })).toBe(
			conflictsBefore,
		);
		expect(await deadlocksOf(sql)).toBe(deadlocksBefore);
	});

	test("TST-C-09 40 rounds racing at once: still exactly one winner each, no deadlock", async () => {
		const deadlocksBefore = await deadlocksOf(sql);
		const wallets = await Promise.all(
			Array.from({ length: 80 }, () => api.createWallet("100.00")),
		);
		const pairs = Array.from({ length: 40 }, (_, i) => {
			const first = wallets[2 * i];
			const second = wallets[2 * i + 1];
			if (first === undefined || second === undefined) throw new Error("setup");
			return { first, second, externalTransactionId: `burst-${uniqueId()}` };
		});

		const replies = await Promise.all(
			pairs.flatMap(({ first, second, externalTransactionId }) => [
				api.submit(first, "10.00", {
					externalTransactionId,
					key: `k1-${uniqueId()}`,
				}),
				api.submit(second, "10.00", {
					externalTransactionId,
					key: `k2-${uniqueId()}`,
				}),
			]),
		);

		expectNoServerError(replies);
		for (let i = 0; i < pairs.length; i++) {
			const pair = [replies[2 * i], replies[2 * i + 1]];
			expect(statusesOf(pair.filter((r) => r !== undefined)).sort()).toEqual([
				201, 409,
			]);
		}
		expect(await api.metric("lock_conflicts_total", { type: "deadlock" })).toBe(
			0,
		);
		expect(await deadlocksOf(sql)).toBe(deadlocksBefore);
		await assertWalletsConsistent(p, wallets);
	});
});

describe("TST-C-11 REFUND and ROLLBACK of the same BET in parallel", () => {
	test("TST-C-11 exactly one PROCESSED, the other REJECTED REFERENCE_ALREADY_REVERSED, balance restored once (30 rounds)", async () => {
		const wallets = [];
		for (let i = 0; i < 30; i++) {
			const w = await api.createWallet("100.00");
			wallets.push(w);
			const bet = api.buildSubmit(w, "40.00");
			expect(
				(await api.request("POST", "/wagering/transactions", bet)).status,
			).toBe(201);

			const replies = await Promise.all([
				api.submit(w, "40.00", {
					kind: "REFUND",
					reference: bet.body.externalTransactionId,
				}),
				api.submit(w, "40.00", {
					kind: "ROLLBACK",
					reference: bet.body.externalTransactionId,
				}),
			]);

			expectNoServerError(replies);
			expect(statusesOf(replies).sort()).toEqual([201, 422]);
			const loser = replies.find((r) => r.status === 422);
			expect(loser?.body).toMatchObject({
				status: "REJECTED",
				failureCode: "REFERENCE_ALREADY_REVERSED",
			});
			expect(await api.balanceOf(w)).toBe("100.00");
			const credits = (await ledgerRows(sql, w.id)).filter(
				(e) => e.direction === "CREDIT" && e.wallet_version > 1,
			);
			expect(credits).toHaveLength(1);
		}
		await assertWalletsConsistent(p, wallets);
	});

	test("TST-C-11 20 REFUND/ROLLBACK pairs racing at once", async () => {
		const wallets = await Promise.all(
			Array.from({ length: 20 }, () => api.createWallet("100.00")),
		);
		const bets = wallets.map((w) => api.buildSubmit(w, "40.00"));
		const placed = await Promise.all(
			bets.map((bet) => api.request("POST", "/wagering/transactions", bet)),
		);
		expect(statusesOf(placed)).toEqual(Array(20).fill(201));

		const replies = await Promise.all(
			wallets.flatMap((w, i) => {
				const reference = bets[i]?.body.externalTransactionId;
				return [
					api.submit(w, "40.00", { kind: "REFUND", reference }),
					api.submit(w, "40.00", { kind: "ROLLBACK", reference }),
				];
			}),
		);

		expectNoServerError(replies);
		for (let i = 0; i < wallets.length; i++) {
			const pair = [replies[2 * i], replies[2 * i + 1]];
			expect(statusesOf(pair.filter((r) => r !== undefined)).sort()).toEqual([
				201, 422,
			]);
		}
		for (const w of wallets) expect(await api.balanceOf(w)).toBe("100.00");
		await assertWalletsConsistent(p, wallets);
	});
});
