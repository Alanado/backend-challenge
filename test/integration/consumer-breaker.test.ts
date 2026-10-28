import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WagerTransactionMessageHandler } from "../../src/modules/wagering/application/wager-transaction-message-handler";
import { assertLedgerInvariant } from "../support/assertLedgerInvariant";
import {
	type ConsumerEnv,
	createConsumerEnv,
	wagerMessage,
} from "../support/consumer-env";
import { eventually, holdsFor } from "../support/eventually";
import { type HttpApp, startHttpApp } from "../support/http-app";
import { testInfra } from "../support/infra";
import { createPersistence } from "../support/persistence";
import { connect } from "../support/sql";
import { queueDepth } from "../support/sqs-poller";
import { createSubmitHarness } from "../support/submit-harness";
import { startTcpProxy, type TcpProxy } from "../support/tcp-proxy";

let env: ConsumerEnv;
let proxy: TcpProxy;
let app: HttpApp;

beforeAll(async () => {
	env = await createConsumerEnv("i20", { visibilityTimeoutS: 5 });
	const target = new URL(testInfra.databaseUrl);
	proxy = await startTcpProxy(target.hostname, Number(target.port));
	// The application reaches the database only through the proxy; the test and every other suite
	// talk to the real PostgreSQL directly, which never goes down.
	const proxied = new URL(env.db.url);
	proxied.hostname = "127.0.0.1";
	proxied.port = String(proxy.port);
	app = await startHttpApp(env.db, {
		env: {
			DATABASE_URL: proxied.toString(),
			ENABLE_CONSUMER: "true",
			SQS_ENDPOINT: testInfra.sqsEndpoint,
			SQS_QUEUE_NAME: env.queues.main.name,
			SQS_DLQ_NAME: env.queues.dlq.name,
			SQS_WAIT_TIME_S: "1",
			BREAKER_COOLDOWN_MIN_MS: "200",
			BREAKER_COOLDOWN_MAX_MS: "800",
			DB_POOL_MAX: "5",
		},
	});
});

afterAll(async () => {
	await app.stop();
	proxy.stop();
	await env.close();
});

describe("TST-I-20 the database goes away during consumption", () => {
	test("TST-I-20 the breaker opens, nothing reaches the DLQ, and once the database is back every message is processed exactly once", async () => {
		const wallet = await env.wallet("100.00");
		const externalIds: string[] = [];
		proxy.setLatency(15); // slow statements: the outage lands in the middle of the 20 messages
		for (let i = 0; i < 20; i++) {
			const message = wagerMessage(wallet, { amount: "1.00" });
			externalIds.push(message.externalTransactionId);
			await env.send(message, wallet);
		}
		const balance = async () =>
			Number(
				(
					await env.sql.query("select balance from wallets where id = $1", [
						wallet.id,
					])
				).rows[0].balance,
			);

		// Consumption is under way: a few BETs are in, most are not.
		await eventually(
			async () => expect(await balance()).toBeLessThanOrEqual(98),
			{
				timeout: 30_000,
			},
		);
		expect(await balance()).toBeGreaterThan(80);

		proxy.drop();

		await eventually(
			async () => expect(await app.metric("circuit_breaker_open")).toBe(1),
			{ timeout: 15_000 },
		);
		const balanceWhenOpen = await balance();

		// Several cooldown cycles (200, 400, 800, 800... ms) with a dead database: no message is
		// dead-lettered, none is applied, the breaker stays open and the process stays up.
		await holdsFor(
			4000,
			async () => {
				expect(await queueDepth(env.sqs, env.queues.dlq.url)).toBe(0);
				expect(await app.metric("circuit_breaker_open")).toBe(1);
				expect(await app.metric("dlq_messages_total")).toBe(0);
				expect(await balance()).toBe(balanceWhenOpen);
				expect(app.process.proc.exitCode).toBeNull();
			},
			250,
		);
		expect(await queueDepth(env.sqs, env.queues.main.url)).toBeGreaterThan(0);

		proxy.setLatency(0);
		proxy.restore();

		await eventually(
			async () => expect(await app.metric("circuit_breaker_open")).toBe(0),
			{ timeout: 20_000 },
		);
		await eventually(async () => expect(await balance()).toBe(80), {
			timeout: 60_000,
		});
		await eventually(
			async () =>
				expect(await queueDepth(env.sqs, env.queues.main.url)).toBe(0),
			{ timeout: 20_000 },
		);

		// Exactly once: 20 distinct transactions, 20 debits (+ the opening credit), nothing dead-lettered.
		const rows = await env.sql.query(
			`select external_transaction_id, status from wager_transactions
			  where wallet_id = $1 and kind = 'BET'`,
			[wallet.id],
		);
		expect(rows.rows.map((r) => r.external_transaction_id).sort()).toEqual(
			[...externalIds].sort(),
		);
		expect(rows.rows.every((r) => r.status === "PROCESSED")).toBe(true);
		const ledger = await env.sql.query(
			"select count(*)::int as n from wallet_ledger_entries where wallet_id = $1",
			[wallet.id],
		);
		expect(ledger.rows[0].n).toBe(21);
		expect(await queueDepth(env.sqs, env.queues.dlq.url)).toBe(0);
		expect(await app.metric("dlq_messages_total")).toBe(0);
		await assertLedgerInvariant(env.p.ledgerIntegrity, wallet.id);
	}, 120_000);
});

describe("X-BREAKER what feeds the breaker", () => {
	const inbound = (body: string) => ({
		id: `broker-${crypto.randomUUID()}`,
		body,
		receiveCount: 1,
		groupId: "g",
		deduplicationId: crypto.randomUUID(),
	});

	test("X-BREAKER an unreachable database is reported and the message is released at once", async () => {
		const target = new URL(testInfra.databaseUrl);
		const own = await startTcpProxy(target.hostname, Number(target.port));
		const url = new URL(env.db.url);
		url.hostname = "127.0.0.1";
		url.port = String(own.port);
		const failures: string[] = [];
		const rig = await env.rig();
		// A second persistence, behind the proxy, for this handler only.
		const behind = await createPersistence(url.toString());
		const harness = createSubmitHarness(behind);
		const handler = new WagerTransactionMessageHandler({
			submit: harness.submit,
			exhausted: rig.exhausted,
			metrics: harness.metrics,
			logger: harness.logger,
			backoff: { baseS: 1, capS: 4 },
			maxReceive: 8,
			infrastructure: { reportFailure: () => failures.push("infrastructure") },
		});
		const wallet = await env.wallet("100.00");
		try {
			own.drop();
			const result = await handler.process(
				inbound(wagerMessage(wallet, { amount: "5.00" }).body),
			);

			expect(result.kind).toBe("release");
			expect(failures).toEqual(["infrastructure"]);
		} finally {
			own.stop();
			await behind.close();
		}
	}, 30_000);

	test("X-BREAKER a lock timeout is retried with backoff and never reported to the breaker", async () => {
		const failures: string[] = [];
		const rig = await env.rig({
			persistence: { lockTimeoutMs: 150 },
			infrastructure: { reportFailure: () => failures.push("infrastructure") },
		});
		const wallet = await env.wallet("100.00");
		const holder = await connect(env.db.url);
		await holder.query("begin");
		await holder.query("select id from wallets where id = $1 for update", [
			wallet.id,
		]);
		try {
			const result = await rig.handler.process(
				inbound(wagerMessage(wallet, { amount: "5.00" }).body),
			);

			expect(result.kind).toBe("retry");
			expect(failures).toEqual([]);
		} finally {
			await holder.query("rollback");
			await holder.end();
		}
	}, 30_000);
});
