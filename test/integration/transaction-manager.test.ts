import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import {
	InfrastructureUnavailableError,
	TransientPersistenceError,
} from "../../src/modules/platform/application/persistence-errors";
import { assertCreatedWalletsConsistent } from "../support/assertLedgerInvariant";
import { openWalletWithOpening } from "../support/domain-builders";
import { createPersistence, type Persistence } from "../support/persistence";
import { connect, failureOf, UNIQUE_VIOLATION } from "../support/sql";
import {
	createSuiteDatabase,
	type SuiteDatabase,
} from "../support/suite-database";

let db: SuiteDatabase;
let p: Persistence;
let shortLock: Persistence;
let shortStatement: Persistence;
let admin: Client;

beforeAll(async () => {
	db = await createSuiteDatabase();
	p = await createPersistence(db.url);
	shortLock = await createPersistence(db.url, { lockTimeoutMs: 200 });
	shortStatement = await createPersistence(db.url, { statementTimeoutMs: 150 });
	admin = await connect(db.url);
});

afterAll(async () => {
	await admin.end();
	await p.close();
	await shortLock.close();
	await shortStatement.close();
	await db.drop();
});

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("X-20 TransactionManager translates database failures (PostgreSQL real)", () => {
	test("X-20 FOR UPDATE blocks the second transaction until the first ends; lock_timeout becomes TransientPersistenceError", async () => {
		const wallet = await openWalletWithOpening(p, "10.00");
		const holding = deferred();
		const release = deferred();

		const holder = p.tm.run(async () => {
			await p.wallets.findByIdForUpdate(wallet.id);
			holding.resolve();
			await release.promise;
			return "released";
		});
		await holding.promise;

		const blocked = shortLock.tm.run(() =>
			shortLock.wallets.findByIdForUpdate(wallet.id),
		);
		const error = await blocked.then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(TransientPersistenceError);
		expect((error as TransientPersistenceError).kind).toBe("lock_timeout");
		expect(
			((error as TransientPersistenceError).cause as { code?: string }).code,
		).toBe("55P03");

		release.resolve();
		expect(await holder).toBe("released");
		// Once the holder committed, the same lock is granted immediately.
		const free = await shortLock.tm.run(() =>
			shortLock.wallets.findByIdForUpdate(wallet.id),
		);
		expect(free?.id).toBe(wallet.id);
	});

	test("X-20 a plain read does not wait for the FOR UPDATE holder", async () => {
		const wallet = await openWalletWithOpening(p, "10.00");
		const holding = deferred();
		const release = deferred();
		const holder = p.tm.run(async () => {
			await p.wallets.findByIdForUpdate(wallet.id);
			holding.resolve();
			await release.promise;
		});
		await holding.promise;
		const seen = await shortLock.wallets.findById(wallet.id);
		expect(seen?.id).toBe(wallet.id);
		release.resolve();
		await holder;
	});

	test("X-20 crossed FOR UPDATE locks raise a deadlock, translated as TransientPersistenceError", async () => {
		const w1 = await openWalletWithOpening(p, "10.00");
		const w2 = await openWalletWithOpening(p, "10.00");
		const bothHold = [deferred(), deferred()];

		const crossing = (first: string, second: string, mine: number) =>
			p.tm.run(async () => {
				await p.wallets.findByIdForUpdate(first);
				bothHold[mine]?.resolve();
				await Promise.all(bothHold.map((d) => d.promise));
				await p.wallets.findByIdForUpdate(second);
			});

		const results = await Promise.allSettled([
			crossing(w1.id, w2.id, 0),
			crossing(w2.id, w1.id, 1),
		]);

		const rejected = results.filter(
			(r): r is PromiseRejectedResult => r.status === "rejected",
		);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		const reason = rejected[0]?.reason;
		expect(reason).toBeInstanceOf(TransientPersistenceError);
		expect((reason as TransientPersistenceError).kind).toBe("deadlock");
	});

	test("X-20 statement_timeout becomes TransientPersistenceError(statement_timeout)", async () => {
		const error = await shortStatement.tm
			.run(async () => {
				await shortStatement.tm.current().execute("select pg_sleep(5)");
			})
			.then(
				() => undefined,
				(e: unknown) => e,
			);
		expect(error).toBeInstanceOf(TransientPersistenceError);
		expect((error as TransientPersistenceError).kind).toBe("statement_timeout");
	});

	test("X-20 a connection killed mid-transaction becomes InfrastructureUnavailableError", async () => {
		const victim = await createPersistence(db.url);
		try {
			const error = await victim.tm
				.run(async () => {
					const rows = await victim.tm
						.current()
						.execute("select pg_backend_pid() as pid");
					await admin.query("select pg_terminate_backend($1)", [
						(rows[0] as { pid: number }).pid,
					]);
					await victim.tm.current().execute("select 1");
				})
				.then(
					() => undefined,
					(e: unknown) => e,
				);
			expect(error).toBeInstanceOf(InfrastructureUnavailableError);
		} finally {
			await victim.close();
		}
	});

	test("X-21 killed connections do not leak pool slots: a pool of 2 survives 4 kills", async () => {
		const small = await createPersistence(db.url, { poolMax: 2 });
		try {
			for (let i = 0; i < 4; i++) {
				const error = await small.tm
					.run(async () => {
						const rows = await small.tm
							.current()
							.execute("select pg_backend_pid() as pid");
						await admin.query("select pg_terminate_backend($1)", [
							(rows[0] as { pid: number }).pid,
						]);
						await small.tm.current().execute("select 1");
					})
					.then(
						() => undefined,
						(e: unknown) => e,
					);
				expect(error).toBeInstanceOf(InfrastructureUnavailableError);
			}
			// With leaked slots this would wait for a connection forever; bound it so the failure is an assert.
			const outcome = await Promise.race([
				small.tm.run(async () => {
					const rows = await small.tm.current().execute("select 42 as n");
					return (rows[0] as { n: number }).n;
				}),
				new Promise<string>((resolve) =>
					setTimeout(() => resolve("pool exhausted"), 3000),
				),
			]);
			expect(outcome).toBe(42);
		} finally {
			await Promise.race([
				small.close(),
				new Promise((r) => setTimeout(r, 1000)),
			]);
		}
	});

	test("X-20 a refused connection becomes InfrastructureUnavailableError", async () => {
		const url = new URL(db.url);
		url.port = "1";
		const unreachable = await createPersistence(url.toString());
		try {
			const error = await unreachable.tm
				.run(async () => 1)
				.then(
					() => undefined,
					(e: unknown) => e,
				);
			expect(error).toBeInstanceOf(InfrastructureUnavailableError);
		} finally {
			await unreachable.close();
		}
	});

	test("X-20 constraint violations and other errors keep their original shape", async () => {
		const wallet = await openWalletWithOpening(p, "10.00");
		const twin = await failureOf(
			p.tm.run(async () => {
				await p.wallets.insert(wallet);
			}),
		);
		expect(twin.code).toBe("23505");
		expect(twin.code).toBe(UNIQUE_VIOLATION);
		await expect(
			p.tm.run(async () => {
				throw new RangeError("application bug");
			}),
		).rejects.toBeInstanceOf(RangeError);
	});

	test("X-20 nested run joins the outer transaction (one commit, one rollback)", async () => {
		const wallet = await openWalletWithOpening(p, "10.00");
		await expect(
			p.tm.run(async () => {
				await p.tm.run(async () => {
					await p.tm
						.current()
						.execute("update wallets set updated_at = now() where id = ?", [
							wallet.id,
						]);
				});
				throw new Error("outer fails");
			}),
		).rejects.toThrow("outer fails");
		const after = await p.wallets.findById(wallet.id);
		expect(after?.updatedAt.getTime()).toBe(wallet.updatedAt.getTime());
	});

	test("X-20 timeouts are SET LOCAL: they apply inside run and are gone after it", async () => {
		const inside = await shortLock.tm.run(async () => {
			const rows = await shortLock.tm.current().execute("show lock_timeout");
			return (rows[0] as { lock_timeout: string }).lock_timeout;
		});
		expect(inside).toBe("200ms");
		const outside = await shortLock.tm.current().execute("show lock_timeout");
		expect((outside[0] as { lock_timeout: string }).lock_timeout).toBe("0");
	});
});

describe("TST-I-14 invariant over what this suite created", () => {
	test("TST-I-14 every wallet created by the transaction manager tests still satisfies the ledger invariant", async () => {
		expect(p.created.length).toBeGreaterThan(5);
		await assertCreatedWalletsConsistent(p.ledgerIntegrity, p.created);
	});
});
