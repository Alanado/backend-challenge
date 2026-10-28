import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { newSqsClient, TestEventConsumer } from "../support/event-consumer";
import { eventually } from "../support/eventually";
import { type HttpApp, startHttpApp } from "../support/http-app";
import { testInfra } from "../support/infra";
import {
	createSuiteDatabase,
	type SuiteDatabase,
} from "../support/suite-database";
import { createSuiteQueues, type SuiteQueues } from "../support/suite-queues";

let db: SuiteDatabase;
let queues: SuiteQueues;
let app: HttpApp;
const sqs = newSqsClient();

beforeAll(async () => {
	db = await createSuiteDatabase();
	queues = await createSuiteQueues("obxrole");
	app = await startHttpApp(db, {
		env: {
			ENABLE_OUTBOX_PUBLISHER: "true",
			OUTBOX_POLL_MS: "50",
			SQS_ENDPOINT: testInfra.sqsEndpoint,
			SQS_EVENTS_QUEUE_NAME: queues.events.name,
		},
	});
});

afterAll(async () => {
	await app.stop();
	sqs.destroy();
	await queues.destroy();
	await db.drop();
});

describe("TST-I-13 outbox publisher role (the real application process)", () => {
	test("TST-I-13 with ENABLE_OUTBOX_PUBLISHER on, a BET over HTTP reaches the events queue", async () => {
		const wallet = await app.createWallet("100.00");
		const reply = await app.submit(wallet, "25.00");
		expect(reply.status).toBe(201);

		const consumer = new TestEventConsumer(sqs, queues.events.url);
		await consumer.pollUntil(() => consumer.inbox.size >= 3);

		const types = [...consumer.inbox.values()].map((e) => e.eventType).sort();
		expect(types).toEqual([
			"WagerTransactionProcessed",
			"WalletBalanceChanged",
			"WalletBalanceChanged",
		]);
		for (const event of consumer.inbox.values()) {
			expect(event.groupId).toBe(wallet.id);
		}
		await eventually(async () =>
			expect(await app.metric("outbox_lag_seconds")).toBe(0),
		);
	});
});
