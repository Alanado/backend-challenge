import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EntityManager } from "@mikro-orm/postgresql";
import { type INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { InboxRepository } from "../../src/modules/messaging/application/inbox-repository";
import { OutboxRepository } from "../../src/modules/messaging/application/outbox-repository";
import { MikroInboxRepository } from "../../src/modules/messaging/infrastructure/mikro-inbox.repository";
import { MikroOutboxRepository } from "../../src/modules/messaging/infrastructure/mikro-outbox.repository";
import { TransactionManager } from "../../src/modules/platform/application/transaction-manager";
import { infrastructureModule } from "../../src/modules/platform/infrastructure/infrastructure.module";
import { MikroTransactionManager } from "../../src/modules/platform/infrastructure/mikro-transaction-manager";
import { TransactionRunner } from "../../src/modules/platform/infrastructure/transaction-runner";
import { WagerTransactionRepository } from "../../src/modules/wagering/application/wager-transaction-repository";
import { MikroWagerTransactionRepository } from "../../src/modules/wagering/infrastructure/mikro-wager-transaction.repository";
import { LedgerRepository } from "../../src/modules/wallet/application/ledger-repository";
import { WalletRepository } from "../../src/modules/wallet/application/wallet-repository";
import { MikroLedgerRepository } from "../../src/modules/wallet/infrastructure/mikro-ledger.repository";
import { MikroWalletRepository } from "../../src/modules/wallet/infrastructure/mikro-wallet.repository";
import { loadConfig } from "../../src/shared/config";
import { uniqueId } from "../support/ids";
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

	test("X-07 the application ports resolve to the MikroORM adapters and work end to end", async () => {
		const wallets = app.get(WalletRepository);
		const tm = app.get(TransactionManager);
		expect(wallets).toBeInstanceOf(MikroWalletRepository);
		expect(app.get(LedgerRepository)).toBeInstanceOf(MikroLedgerRepository);
		expect(app.get(WagerTransactionRepository)).toBeInstanceOf(
			MikroWagerTransactionRepository,
		);
		expect(app.get(InboxRepository)).toBeInstanceOf(MikroInboxRepository);
		expect(app.get(OutboxRepository)).toBeInstanceOf(MikroOutboxRepository);
		expect(tm).toBeInstanceOf(MikroTransactionManager);
		// Nothing was migrated in this database: reaching the table proves the schema is mapped, the miss proves the query ran.
		await expect(wallets.findById(uniqueId())).rejects.toThrow(/wallets/);
	});
});
