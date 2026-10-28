import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EntityManager } from "@mikro-orm/postgresql";
import { NestFactory } from "@nestjs/core";
import { Client } from "pg";
import { appModule } from "../../src/app.module";
import {
	ActiveRoles,
	type RoleName,
} from "../../src/modules/platform/infrastructure/active-roles";
import { loadConfig } from "../../src/shared/config";
import { type AppProcess, freePort, spawnApp } from "../support/app-process";
import { eventually } from "../support/eventually";
import {
	createSuiteDatabase,
	type SuiteDatabase,
} from "../support/suite-database";

let db: SuiteDatabase;

beforeAll(async () => {
	db = await createSuiteDatabase();
});

afterAll(async () => {
	await db.drop();
});

const FLAGS = [
	["ENABLE_HTTP", "http"],
	["ENABLE_CONSUMER", "consumer"],
	["ENABLE_OUTBOX_PUBLISHER", "outbox-publisher"],
	["ENABLE_PENDING_WORKER", "pending-worker"],
] as const satisfies readonly (readonly [string, RoleName])[];

function flagEnv(enabled: readonly RoleName[]): Record<string, string> {
	return Object.fromEntries(
		FLAGS.map(([variable, role]) => [variable, String(enabled.includes(role))]),
	);
}

// Every subset of the four roles: 16 combinations.
const COMBINATIONS: RoleName[][] = Array.from({ length: 16 }, (_, mask) =>
	FLAGS.filter((_, bit) => (mask >> bit) & 1).map(([, role]) => role),
);

describe("BOOT-01 roles are registered according to the ENABLE_* flags (in-process, PostgreSQL real)", () => {
	test.each(COMBINATIONS.map((roles) => [roles]))(
		"BOOT-01 roles %j",
		async (enabled) => {
			const config = loadConfig({
				DATABASE_URL: db.url,
				...flagEnv(enabled),
			});
			const app = await NestFactory.createApplicationContext(
				appModule(config),
				{
					logger: false,
				},
			);
			try {
				await app.init();
				expect(app.get(ActiveRoles).list().sort()).toEqual([...enabled].sort());
			} finally {
				await app.close();
			}
		},
	);

	test("BOOT-02 closing the application closes the connection pool", async () => {
		// A database of its own for this test, so every connection on it is the application's.
		const own = await createSuiteDatabase();
		const admin = new Client({ connectionString: db.url });
		await admin.connect();
		const openConnections = async () =>
			(
				await admin.query(
					"select count(*)::int as n from pg_stat_activity where datname = $1",
					[own.name],
				)
			).rows[0].n as number;
		const config = loadConfig({ DATABASE_URL: own.url });
		const app = await NestFactory.createApplicationContext(appModule(config), {
			logger: false,
		});
		try {
			await app.init();
			await app.get(EntityManager).fork().execute("select 1");
			expect(await openConnections()).toBeGreaterThan(0);

			await app.close();

			await eventually(async () => (await openConnections()) === 0, {
				timeout: 5000,
			});
		} finally {
			await admin.end();
			await own.drop();
		}
	});
});

describe("BOOT-03 the real process (bun src/main.ts)", () => {
	const started: AppProcess[] = [];
	const launch = (env: Record<string, string>) => {
		const app = spawnApp({ DATABASE_URL: db.url, ...env });
		started.push(app);
		return app;
	};
	afterAll(async () => {
		await Promise.all(started.map((app) => app.stop()));
	});

	const listensOn = async (port: number) => {
		try {
			await fetch(`http://127.0.0.1:${port}/`);
			return true;
		} catch {
			return false;
		}
	};

	test("BOOT-03 with every role on, it boots and answers HTTP with a JSON 404", async () => {
		const port = await freePort();
		const app = launch({ PORT: String(port) });
		await app.waitForStdout("app_started");

		const response = await eventually(() =>
			fetch(`http://127.0.0.1:${port}/nothing`),
		);
		expect(response.status).toBe(404);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toMatchObject({ statusCode: 404 });
	});

	test.each([
		[["http"]],
		[["http", "consumer"]],
		[["http", "outbox-publisher", "pending-worker"]],
	] as RoleName[][][])(
		"BOOT-03 roles %j boot and answer HTTP",
		async (enabled) => {
			const port = await freePort();
			const app = launch({ PORT: String(port), ...flagEnv(enabled) });
			await app.waitForStdout("app_started");
			const response = await eventually(() =>
				fetch(`http://127.0.0.1:${port}/`),
			);
			expect(response.status).toBe(404);
			expect(app.stdout()).toContain(JSON.stringify(enabled));
		},
	);

	test("BOOT-03 with ENABLE_HTTP=false it boots without listening", async () => {
		const port = await freePort();
		const app = launch({
			PORT: String(port),
			...flagEnv(["consumer", "pending-worker"]),
		});
		await app.waitForStdout("app_started");

		expect(app.proc.exitCode).toBeNull();
		expect(await listensOn(port)).toBe(false);
		expect(app.stdout()).toContain('"roles":["consumer","pending-worker"]');
	});

	test("BOOT-04 SIGTERM stops it cleanly with exit code 0", async () => {
		const port = await freePort();
		const app = launch({ PORT: String(port) });
		await app.waitForStdout("app_started");

		app.proc.kill("SIGTERM");
		const code = await Promise.race([
			app.exited,
			new Promise<string>((r) => setTimeout(() => r("did not exit"), 10_000)),
		]);

		expect(code).toBe(0);
		expect(app.stdout()).toContain("app_stopped");
		expect(await listensOn(port)).toBe(false);
	});

	test("BOOT-04 SIGTERM also stops an instance without the HTTP role", async () => {
		const app = launch(flagEnv(["consumer"]));
		await app.waitForStdout("app_started");
		app.proc.kill("SIGTERM");
		expect(await app.exited).toBe(0);
	});

	test("BOOT-05 invalid configuration exits non-zero with a readable message", async () => {
		const app = spawnApp({
			DATABASE_URL: db.url,
			PORT: "not-a-port",
			ENABLE_HTTP: "maybe",
		});
		started.push(app);

		const code = await app.exited;

		expect(code).not.toBe(0);
		await eventually(() => app.stderr().includes("PORT"));
		const message = app.stderr();
		expect(message).toContain("invalid configuration");
		expect(message).toContain("PORT");
		expect(message).toContain("ENABLE_HTTP");
		expect(message).not.toContain("    at ");
		expect(app.stdout()).not.toContain("app_started");
	});

	test("BOOT-05 a missing DATABASE_URL exits non-zero and names the variable", async () => {
		const app = spawnApp({ PORT: String(await freePort()) });
		started.push(app);
		expect(await app.exited).not.toBe(0);
		await eventually(() => app.stderr().includes("DATABASE_URL"));
	});

	test("BOOT-06 NODE_ENV=production with TEST_FAULT aborts at boot without listening", async () => {
		const port = await freePort();
		const app = spawnApp({
			DATABASE_URL: db.url,
			PORT: String(port),
			NODE_ENV: "production",
			TEST_FAULT: "fail-mid-transaction",
		});
		started.push(app);

		const code = await app.exited;

		expect(code).not.toBe(0);
		await eventually(() => app.stderr().includes("TEST_FAULT"));
		expect(app.stderr()).toContain("refused when NODE_ENV=production");
		expect(app.stdout()).not.toContain("app_started");
		expect(await listensOn(port)).toBe(false);
	});

	test("BOOT-06 the same TEST_FAULT is accepted outside production", async () => {
		const port = await freePort();
		const app = launch({
			PORT: String(port),
			NODE_ENV: "test",
			TEST_FAULT: "fail-mid-transaction",
		});
		await app.waitForStdout("app_started");
		expect(app.proc.exitCode).toBeNull();
	});
});
