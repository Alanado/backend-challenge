import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eventually } from "../support/eventually";
import { type HttpApp, startHttpApp } from "../support/http-app";
import { uniqueId } from "../support/ids";
import {
	createSuiteDatabase,
	type SuiteDatabase,
} from "../support/suite-database";

let db: SuiteDatabase;
let app: HttpApp;

beforeAll(async () => {
	db = await createSuiteDatabase();
	app = await startHttpApp(db, {
		env: {
			ENABLE_PENDING_WORKER: "true",
			PENDING_REF_POLL_MS: "50",
			PENDING_REF_BASE_MS: "50",
			PENDING_REF_CAP_MS: "200",
			PENDING_REF_MAX_ATTEMPTS: "50",
		},
	});
});

afterAll(async () => {
	await app.stop();
	await db.drop();
});

describe("TST-I-10 pending-reference worker role (the real application process)", () => {
	test("TST-I-10 with ENABLE_PENDING_WORKER on, a REFUND sent before its BET ends PROCESSED without any further request", async () => {
		const wallet = await app.createWallet("100.00");
		const betId = `bet-${uniqueId()}`;

		const refund = await app.submit(wallet, "25.00", {
			kind: "REFUND",
			reference: betId,
		});
		expect(refund.status).toBe(202);
		expect(refund.body.status).toBe("PENDING_REFERENCE");
		const bet = await app.submit(wallet, "25.00", {
			externalTransactionId: betId,
		});
		expect(bet.status).toBe(201);

		await eventually(
			async () => {
				const reply = await app.request(
					"GET",
					`/wagering/transactions/${refund.body.transactionId}`,
				);
				expect(reply.body.status).toBe("PROCESSED");
			},
			{ timeout: 10_000, interval: 50 },
		);
		expect(await app.balanceOf(wallet)).toBe("100.00");
	});
});
