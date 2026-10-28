import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EntityManager } from "@mikro-orm/postgresql";
import { type INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { infrastructureModule } from "../../src/modules/platform/infrastructure/infrastructure.module";
import { TransactionRunner } from "../../src/modules/platform/infrastructure/transaction-runner";
import { loadConfig } from "../../src/shared/config";
import { testInfra } from "../support/infra";

const config = loadConfig({
	DATABASE_URL: testInfra.databaseUrl,
	LOCK_TIMEOUT_MS: "1234",
	STATEMENT_TIMEOUT_MS: "4321",
	DB_POOL_MAX: "7",
});

// Rows of em.execute are untyped; this keeps noUncheckedIndexedAccess honest.
function first(rows: Record<string, unknown>[]): Record<string, unknown> {
	const row = rows[0];
	if (!row) throw new Error("expected one row");
	return row;
}

let app: INestApplicationContext;
let runner: TransactionRunner;
let em: EntityManager;

describe("platform infrastructure module (PostgreSQL real)", () => {
	beforeAll(async () => {
		app = await NestFactory.createApplicationContext(
			infrastructureModule(config),
			{ logger: false },
		);
		runner = app.get(TransactionRunner);
		em = app.get(EntityManager);
	});
	afterAll(async () => {
		await app.close();
	});

	test("X-01 connects and answers a query", async () => {
		const rows = await em.fork().execute("select 1 as one");
		expect(first(rows).one).toBe(1);
	});

	test("X-02 caps concurrent connections at DB_POOL_MAX", async () => {
		const pids = await Promise.all(
			Array.from({ length: 20 }, () =>
				em
					.fork()
					.execute("select pg_backend_pid() as pid, pg_sleep(0.3)")
					.then((rows) => first(rows).pid as number),
			),
		);
		expect(new Set(pids).size).toBe(7);
	});

	test("X-03 applies lock_timeout and statement_timeout inside the transaction", async () => {
		const seen = await runner.run(async (tx) => {
			const lock = await tx.execute("show lock_timeout");
			const statement = await tx.execute("show statement_timeout");
			return {
				lock: first(lock).lock_timeout,
				statement: first(statement).statement_timeout,
			};
		});
		expect(seen).toEqual({ lock: "1234ms", statement: "4321ms" });
	});

	test("X-04 timeouts do not leak outside the transaction", async () => {
		await runner.run(async (tx) => {
			await tx.execute("select 1");
		});
		// Runs on the pool again, possibly on the very connection the transaction used.
		const lock = await em.fork().execute("show lock_timeout");
		const statement = await em.fork().execute("show statement_timeout");
		expect(first(lock).lock_timeout).toBe("0");
		expect(first(statement).statement_timeout).toBe("0");
	});

	test("X-05 rolls back and rethrows when the callback fails", async () => {
		await expect(
			runner.run(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
	});

	test("X-06 returns the callback result", async () => {
		expect(await runner.run(async () => 42)).toBe(42);
	});
});
