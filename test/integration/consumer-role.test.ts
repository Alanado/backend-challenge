import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { wagerMessage } from "../support/consumer-env";
import { newSqsClient } from "../support/event-consumer";
import { eventually } from "../support/eventually";
import { type HttpApp, startHttpApp } from "../support/http-app";
import { testInfra } from "../support/infra";
import { peekDeadLetters, sendMessage } from "../support/sqs-poller";
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
	queues = await createSuiteQueues("cnsrole");
	app = await startHttpApp(db, {
		env: {
			ENABLE_CONSUMER: "true",
			SQS_ENDPOINT: testInfra.sqsEndpoint,
			SQS_QUEUE_NAME: queues.main.name,
			SQS_DLQ_NAME: queues.dlq.name,
			SQS_WAIT_TIME_S: "1",
		},
	});
});

afterAll(async () => {
	await app.stop();
	sqs.destroy();
	await queues.destroy();
	await db.drop();
});

describe("TST-I-11 consumer role (the real application process)", () => {
	test("TST-I-11 with ENABLE_CONSUMER on, a BET sent to the queue changes the balance seen over HTTP", async () => {
		const wallet = await app.createWallet("100.00");
		const message = wagerMessage(wallet, { amount: "25.00" });
		await sendMessage(sqs, queues.main.url, message.body, wallet.id);

		await eventually(
			async () => expect(await app.balanceOf(wallet)).toBe("75.00"),
			{
				timeout: 15_000,
			},
		);
		const view = await app.request(
			"GET",
			`/providers/provider-a/wagering/transactions/${message.externalTransactionId}`,
		);
		expect(view.status).toBe(200);
		expect(view.body.status).toBe("PROCESSED");
		expect(
			await app.metric("wager_transactions_total", {
				status: "PROCESSED",
				kind: "BET",
				channel: "sqs",
				failure_code: "none",
			}),
		).toBe(1);
	});

	test("TST-I-12 a permanent failure reaches the DLQ and shows in dlq_messages_total", async () => {
		const poison = "{definitely not json";
		await sendMessage(sqs, queues.main.url, poison, "any-group");

		await eventually(
			async () => {
				const dead = await peekDeadLetters(sqs, queues.dlq.url);
				expect(dead.map((d) => d.body)).toContain(poison);
			},
			{ timeout: 15_000 },
		);
		expect(
			await app.metric("dlq_messages_total", { reason: "invalid_json" }),
		).toBe(1);
	});
});
