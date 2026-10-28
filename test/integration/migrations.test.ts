import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { withMigrator } from "../../scripts/lib/migrator";
import {
	connect,
	insertLedgerEntry,
	insertTransaction,
	insertWallet,
} from "../support/sql";
import {
	createSuiteDatabase,
	migrationsPath,
	type SuiteDatabase,
} from "../support/suite-database";

// Tables each migration owns; this list grows with the migrations (T-021..T-023).
const MIGRATION_1_TABLES = ["wallets", "wager_transactions"];
const MIGRATION_2_TABLES = ["wallet_ledger_entries"];
const ALL_TABLES = [...MIGRATION_1_TABLES, ...MIGRATION_2_TABLES];

let db: SuiteDatabase;
let client: Client;

const up = () =>
	withMigrator(db.url, migrationsPath(), (migrator) => migrator.up(), {
		silent: true,
	});
const downAll = () =>
	withMigrator(
		db.url,
		migrationsPath(),
		(migrator) => migrator.down({ to: 0 }),
		{
			silent: true,
		},
	);
const downOne = () =>
	withMigrator(db.url, migrationsPath(), (migrator) => migrator.down(), {
		silent: true,
	});

async function existingTables(): Promise<string[]> {
	const res = await client.query(
		"select tablename from pg_tables where schemaname = 'public' and tablename <> 'mikro_orm_migrations' order by tablename",
	);
	return res.rows.map((r) => r.tablename as string);
}

beforeAll(async () => {
	// Unmigrated on purpose: this suite drives the migrator itself.
	db = await createSuiteDatabase({ migrated: false });
	client = await connect(db.url);
});

afterAll(async () => {
	await client.end();
	await db.drop();
});

describe("TST-I-01 migrations up and down", () => {
	test("TST-I-01 up creates the schema, down removes it all, up recreates it", async () => {
		await up();
		expect(await existingTables()).toEqual([...ALL_TABLES].sort());
		await downAll();
		expect(await existingTables()).toEqual([]);
		await up();
		expect(await existingTables()).toEqual([...ALL_TABLES].sort());
	});

	test("TST-I-01 up is idempotent: a second up applies nothing", async () => {
		await up();
		const applied = await up();
		expect(applied).toHaveLength(0);
	});

	test("TST-I-01 down/up/down works with populated tables", async () => {
		await up();
		const wallet = await insertWallet(client);
		await insertTransaction(client, wallet.id as string, {
			status: "PROCESSED",
			processed_at: new Date(),
		});
		await insertTransaction(client, wallet.id as string, {
			status: "REJECTED",
			failure_code: "INSUFFICIENT_FUNDS",
		});
		await downAll();
		expect(await existingTables()).toEqual([]);
		await up();
		await downAll();
		expect(await existingTables()).toEqual([]);
	});

	test("TST-I-01 down/up/down works with a populated ledger and terminal transactions (triggers active)", async () => {
		await up();
		const wallet = (await insertWallet(client)).id as string;
		const processed = (
			await insertTransaction(client, wallet, {
				status: "PROCESSED",
				processed_at: new Date(),
			})
		).id as string;
		await insertTransaction(client, wallet, {
			status: "FAILED",
			failure_code: "INTERNAL_ERROR",
		});
		await insertLedgerEntry(client, wallet, processed);
		await downAll();
		expect(await existingTables()).toEqual([]);
		await up();
		const again = (await insertWallet(client)).id as string;
		const tx = (
			await insertTransaction(client, again, {
				status: "PROCESSED",
				processed_at: new Date(),
			})
		).id as string;
		await insertLedgerEntry(client, again, tx);
		await downAll();
		expect(await existingTables()).toEqual([]);
	});

	test("TST-I-01 down leaves no trigger functions behind", async () => {
		await up();
		await downAll();
		const res = await client.query(
			"select proname from pg_proc where proname in ('ledger_append_only', 'wager_transactions_guard')",
		);
		expect(res.rows).toEqual([]);
	});

	test("TST-I-01 each migration reverts on its own, one step at a time", async () => {
		await up();
		let steps = 0;
		while ((await existingTables()).length > 0) {
			const reverted = await downOne();
			expect(reverted.length).toBe(1);
			steps += 1;
			expect(steps).toBeLessThan(20);
		}
		await up();
	});
});
