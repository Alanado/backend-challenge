import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DeleteQueueCommand } from "@aws-sdk/client-sqs";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { appModule } from "../../src/app.module";
import { CircuitBreaker } from "../../src/modules/messaging/application/circuit-breaker";
import { LifecycleState } from "../../src/modules/platform/infrastructure/lifecycle-state";
import { loadConfig } from "../../src/shared/config";
import { newSqsClient } from "../support/event-consumer";
import { eventually } from "../support/eventually";
import { sampleOf } from "../support/http-app";
import { testInfra } from "../support/infra";
import { createFifoQueue } from "../support/outbox-env";
import {
	createSuiteDatabase,
	type SuiteDatabase,
} from "../support/suite-database";
import { createSuiteQueues, type SuiteQueues } from "../support/suite-queues";
import { startTcpProxy, type TcpProxy } from "../support/tcp-proxy";

let db: SuiteDatabase;
let queues: SuiteQueues;
let dbProxy: TcpProxy;
let sqsProxy: TcpProxy;
const apps: INestApplication[] = [];

beforeAll(async () => {
	db = await createSuiteDatabase();
	queues = await createSuiteQueues("i16");
	const database = new URL(testInfra.databaseUrl);
	dbProxy = await startTcpProxy(database.hostname, Number(database.port));
	const sqs = new URL(testInfra.sqsEndpoint);
	sqsProxy = await startTcpProxy(sqs.hostname, Number(sqs.port));
});

afterAll(async () => {
	for (const app of apps) await app.close();
	dbProxy.stop();
	sqsProxy.stop();
	await queues.destroy();
	await db.drop();
});

interface Running {
	app: INestApplication;
	base: string;
	get(path: string): Promise<{ status: number; body: unknown; ms: number }>;
	metric(name: string, labels?: Record<string, string>): Promise<number>;
}

interface StartOptions {
	/** Reach the database through the proxy (so a test can take it away). */
	viaDbProxy?: boolean;
	/** Reach SQS through the proxy (so a test can make it hang). */
	viaSqsProxy?: boolean;
	env?: Record<string, string>;
}

/** The whole application in this process (all four roles), against the real PostgreSQL and SQS. */
async function start(options: StartOptions = {}): Promise<Running> {
	const databaseUrl = new URL(db.url);
	if (options.viaDbProxy === true) {
		databaseUrl.hostname = "127.0.0.1";
		databaseUrl.port = String(dbProxy.port);
	}
	const sqsEndpoint =
		options.viaSqsProxy === true
			? `http://127.0.0.1:${sqsProxy.port}`
			: testInfra.sqsEndpoint;
	const config = loadConfig({
		NODE_ENV: "test",
		DATABASE_URL: databaseUrl.toString(),
		LOG_LEVEL: "error",
		SQS_ENDPOINT: sqsEndpoint,
		SQS_QUEUE_NAME: queues.main.name,
		SQS_DLQ_NAME: queues.dlq.name,
		SQS_EVENTS_QUEUE_NAME: queues.events.name,
		SQS_WAIT_TIME_S: "1",
		DB_POOL_MAX: "5",
		BREAKER_COOLDOWN_MIN_MS: "300",
		BREAKER_COOLDOWN_MAX_MS: "600",
		...options.env,
	});
	const app = await NestFactory.create(appModule(config), { logger: false });
	apps.push(app);
	await app.listen(0);
	const address = app.getHttpServer().address() as { port: number };
	const base = `http://127.0.0.1:${address.port}`;
	const get: Running["get"] = async (path) => {
		const startedAt = performance.now();
		const response = await fetch(`${base}${path}`);
		const text = await response.text();
		const ms = performance.now() - startedAt;
		let body: unknown = text;
		try {
			body = JSON.parse(text);
		} catch {
			// Prometheus text
		}
		return { status: response.status, body, ms };
	};
	return {
		app,
		base,
		get,
		async metric(name, labels = {}) {
			return sampleOf(String((await get("/metrics")).body), name, labels);
		},
	};
}

const ready = async (running: Running) => await running.get("/health/ready");

describe("TST-I-16 GET /health/live and /health/ready (in process, real PostgreSQL and SQS)", () => {
	test("TST-I-16 healthy: live and ready answer 200, ready lists what it checked", async () => {
		const running = await start();

		const live = await running.get("/health/live");
		const result = await ready(running);

		expect(live.status).toBe(200);
		expect(result.status).toBe(200);
		expect(result.body).toEqual({
			status: "up",
			checks: {
				database: "up",
				"queue:transactions": "up",
				"queue:events": "up",
				"circuit-breaker": "up",
				lifecycle: "up",
			},
		});
	});

	test("TST-I-16 the database goes away: live stays 200, ready is 503, and ready is 200 again once it is back", async () => {
		const running = await start({ viaDbProxy: true });
		expect((await ready(running)).status).toBe(200);

		dbProxy.drop();

		const down = await ready(running);
		expect(down.status).toBe(503);
		expect(down.body).toMatchObject({
			status: "down",
			checks: { database: "down" },
		});
		const live = await running.get("/health/live");
		expect(live.status).toBe(200);
		expect(live.ms).toBeLessThan(500);

		dbProxy.restore();

		await eventually(
			async () => expect((await ready(running)).status).toBe(200),
			{
				timeout: 15_000,
				interval: 100,
			},
		);
	});

	test("TST-I-16 a queue that does not exist makes ready 503 until it is created", async () => {
		const missing = `i16-missing-${queues.suffix}.fifo`;
		const running = await start({ env: { SQS_EVENTS_QUEUE_NAME: missing } });

		const down = await ready(running);
		expect(down.status).toBe(503);
		expect(down.body).toMatchObject({
			status: "down",
			checks: { "queue:events": "down", "queue:transactions": "up" },
		});
		expect((await running.get("/health/live")).status).toBe(200);

		const url = await createFifoQueue(missing);
		try {
			await eventually(
				async () => expect((await ready(running)).status).toBe(200),
				{ timeout: 15_000, interval: 100 },
			);
		} finally {
			const sqs = newSqsClient();
			await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
			sqs.destroy();
		}
	});

	test("TST-I-16 an open circuit breaker makes ready 503 (and the gauge says 1) until it closes by itself", async () => {
		const running = await start({
			env: { BREAKER_COOLDOWN_MIN_MS: "3000", BREAKER_COOLDOWN_MAX_MS: "3000" },
		});
		expect((await ready(running)).status).toBe(200);
		expect(await running.metric("circuit_breaker_open")).toBe(0);

		running.app.get(CircuitBreaker, { strict: false }).reportFailure();

		const open = await ready(running);
		expect(open.status).toBe(503);
		expect(open.body).toMatchObject({
			status: "down",
			checks: { "circuit-breaker": "down", database: "up" },
		});
		expect(await running.metric("circuit_breaker_open")).toBe(1);

		// The cooldown ends, the consumer's probe (SELECT 1) passes, the breaker closes.
		await eventually(
			async () => expect((await ready(running)).status).toBe(200),
			{
				timeout: 15_000,
				interval: 100,
			},
		);
		expect(await running.metric("circuit_breaker_open")).toBe(0);
	});

	test("TST-I-16 an instance that is draining answers ready 503 and live 200", async () => {
		const running = await start();
		expect((await ready(running)).status).toBe(200);

		running.app.get(LifecycleState, { strict: false }).drain();

		const draining = await ready(running);
		expect(draining.status).toBe(503);
		expect(draining.body).toMatchObject({
			status: "down",
			checks: { lifecycle: "down", database: "up" },
		});
		expect((await running.get("/health/live")).status).toBe(200);
	});

	test("TST-I-16 a dependency that hangs does not hang the health: 503 within the 2 s timeout, live untouched", async () => {
		const running = await start({ viaDbProxy: true });
		expect((await ready(running)).status).toBe(200);

		dbProxy.setLatency(6000);
		try {
			const slow = await ready(running);
			expect(slow.status).toBe(503);
			expect(slow.body).toMatchObject({ checks: { database: "down" } });
			expect(slow.ms).toBeGreaterThanOrEqual(1800);
			expect(slow.ms).toBeLessThan(3500);
			const live = await running.get("/health/live");
			expect(live.status).toBe(200);
			expect(live.ms).toBeLessThan(500);
		} finally {
			dbProxy.setLatency(0);
		}
		await eventually(
			async () => expect((await ready(running)).status).toBe(200),
			{
				timeout: 20_000,
				interval: 200,
			},
		);
	});

	test("TST-I-16 an SQS that hangs does not hang the health either", async () => {
		const running = await start({ viaSqsProxy: true });
		expect((await ready(running)).status).toBe(200);

		sqsProxy.setLatency(6000);
		try {
			const slow = await ready(running);
			expect(slow.status).toBe(503);
			expect(slow.body).toMatchObject({
				checks: { "queue:transactions": "down", database: "up" },
			});
			expect(slow.ms).toBeLessThan(3500);
		} finally {
			sqsProxy.setLatency(0);
		}
		await eventually(
			async () => expect((await ready(running)).status).toBe(200),
			{
				timeout: 20_000,
				interval: 200,
			},
		);
	});
});

describe("TST-I-17 /metrics still exposes the ten metrics and the counters reflect what was provoked", () => {
	test("TST-I-17 ten metrics, a BET over HTTP counted, the breaker gauge and the DLQ counter as the suite left them", async () => {
		const running = await start();
		const text = String((await running.get("/metrics")).body);
		const types = new Map(
			[...text.matchAll(/^# TYPE (\S+) (\S+)$/gm)].map(
				(m) => [m[1], m[2]] as const,
			),
		);
		expect([...types.keys()].sort()).toEqual(
			[
				"circuit_breaker_open",
				"dlq_messages_total",
				"idempotent_requests_total",
				"lock_conflicts_total",
				"outbox_lag_seconds",
				"outbox_publish_failed_total",
				"processing_duration_seconds",
				"reconciliation_divergences_total",
				"retries_total",
				"wager_transactions_total",
			].sort(),
		);

		const created = await fetch(`${running.base}/wallets`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				playerId: crypto.randomUUID(),
				initialBalance: { amount: "50.00", currency: "BRL" },
			}),
		});
		const wallet = (await created.json()) as { id: string; playerId: string };
		const submit = () =>
			fetch(`${running.base}/wagering/transactions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Idempotency-Key": "provider-a:i17-1",
				},
				body: JSON.stringify({
					providerId: "provider-a",
					externalTransactionId: "i17-1",
					playerId: wallet.playerId,
					walletId: wallet.id,
					roundId: "round-1",
					gameId: "game-1",
					kind: "BET",
					money: { amount: "10.00", currency: "BRL" },
				}),
			});
		expect((await submit()).status).toBe(201);
		expect((await submit()).status).toBe(200);

		expect(
			await running.metric("wager_transactions_total", {
				status: "PROCESSED",
				kind: "BET",
				channel: "http",
			}),
		).toBe(1);
		expect(
			await running.metric("idempotent_requests_total", {
				outcome: "replay",
				channel: "http",
			}),
		).toBe(1);
		expect(await running.metric("dlq_messages_total")).toBe(0);
		expect(await running.metric("lock_conflicts_total")).toBe(0);
	});
});
