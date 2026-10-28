import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { assertLedgerInvariant } from "../support/assertLedgerInvariant";
import { eventually } from "../support/eventually";
import {
	type HttpApp,
	hashOf,
	startHttpApp,
	type TestWallet,
} from "../support/http-app";
import { uniqueId } from "../support/ids";
import { createPersistence, type Persistence } from "../support/persistence";
import { connect, insertTransaction } from "../support/sql";
import {
	createSuiteDatabase,
	type SuiteDatabase,
} from "../support/suite-database";

let db: SuiteDatabase;
let api: HttpApp;
let sql: Client;
let p: Persistence;
const touched: TestWallet[] = [];

beforeAll(async () => {
	db = await createSuiteDatabase();
	// A short lock_timeout makes the real 55P03 cheap to provoke.
	api = await startHttpApp(db, { env: { LOCK_TIMEOUT_MS: "300" } });
	sql = await connect(db.url);
	p = await createPersistence(db.url);
});

afterAll(async () => {
	for (const wallet of touched)
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	await p.close();
	await sql.end();
	await api.stop();
	await db.drop();
});

async function wallet(balance: string, currency = "BRL"): Promise<TestWallet> {
	const created = await api.createWallet(balance, currency);
	touched.push(created);
	return created;
}

const PROBLEM_FIELDS = [
	"correlationId",
	"detail",
	"errorCode",
	"retryable",
	"status",
	"title",
	"type",
];

function expectProblem(
	reply: Awaited<ReturnType<HttpApp["request"]>>,
	status: number,
	errorCode: string,
	retryable: boolean,
) {
	expect(reply.status).toBe(status);
	expect(reply.headers.get("content-type")).toContain(
		"application/problem+json",
	);
	expect(Object.keys(reply.body).sort()).toEqual(PROBLEM_FIELDS);
	expect(reply.body).toMatchObject({
		type: "about:blank",
		status,
		errorCode,
		retryable,
	});
	expect(reply.body.correlationId).toBe(reply.headers.get("x-correlation-id"));
}

describe("TST-I-06 every kind end to end over HTTP", () => {
	test("TST-I-06 BET debits and answers 201 PROCESSED with the observed balance", async () => {
		const w = await wallet("100.00");

		const reply = await api.submit(w, "30.00");

		expect(reply.status).toBe(201);
		expect(reply.body).toEqual({
			transactionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			status: "PROCESSED",
			balance: { amount: "70.00", currency: "BRL" },
			failureCode: null,
			idempotentReplay: false,
		});
		expect(await api.balanceOf(w)).toBe("70.00");
	});

	test("TST-I-06 WIN referencing a BET credits; WIN without reference also credits", async () => {
		const w = await wallet("100.00");
		const bet = api.buildSubmit(w, "40.00");
		await api.request("POST", "/wagering/transactions", bet);

		const referenced = await api.submit(w, "100.00", {
			kind: "WIN",
			reference: bet.body.externalTransactionId,
		});
		const plain = await api.submit(w, "5.00", { kind: "WIN" });

		expect(referenced.status).toBe(201);
		expect(referenced.body.balance.amount).toBe("160.00");
		expect(plain.status).toBe(201);
		expect(plain.body.balance.amount).toBe("165.00");
	});

	test("TST-I-06 LOSS concludes without touching the balance", async () => {
		const w = await wallet("100.00");
		const bet = api.buildSubmit(w, "40.00");
		await api.request("POST", "/wagering/transactions", bet);

		const reply = await api.submit(w, "40.00", {
			kind: "LOSS",
			reference: bet.body.externalTransactionId,
		});

		expect(reply.status).toBe(201);
		expect(reply.body.status).toBe("PROCESSED");
		expect(reply.body.balance.amount).toBe("60.00");
	});

	test("TST-I-06 REFUND restores the BET amount", async () => {
		const w = await wallet("100.00");
		const bet = api.buildSubmit(w, "40.00");
		await api.request("POST", "/wagering/transactions", bet);

		const reply = await api.submit(w, "40.00", {
			kind: "REFUND",
			reference: bet.body.externalTransactionId,
		});

		expect(reply.status).toBe(201);
		expect(reply.body.balance.amount).toBe("100.00");
	});

	test("TST-I-06 ROLLBACK of a WIN debits it back", async () => {
		const w = await wallet("100.00");
		const win = api.buildSubmit(w, "25.00", { kind: "WIN" });
		await api.request("POST", "/wagering/transactions", win);

		const reply = await api.submit(w, "25.00", {
			kind: "ROLLBACK",
			reference: win.body.externalTransactionId,
		});

		expect(reply.status).toBe(201);
		expect(reply.body.balance.amount).toBe("100.00");
	});
});

describe("TST-I-06 status table of 04-api §2", () => {
	test("TST-I-06 REJECTED answers 422 with failureCode on the first time and on the replay", async () => {
		const w = await wallet("10.00");
		const first = api.buildSubmit(w, "50.00");

		const a = await api.request("POST", "/wagering/transactions", first);
		const b = await api.request("POST", "/wagering/transactions", first);

		expect(a.status).toBe(422);
		expect(a.body).toMatchObject({
			status: "REJECTED",
			failureCode: "INSUFFICIENT_FUNDS",
			balance: { amount: "10.00", currency: "BRL" },
			idempotentReplay: false,
		});
		expect(b.status).toBe(422);
		expect(b.body).toMatchObject({
			status: "REJECTED",
			failureCode: "INSUFFICIENT_FUNDS",
			idempotentReplay: true,
		});
		expect(b.body.transactionId).toBe(a.body.transactionId);
	});

	test("TST-I-06 PENDING_REFERENCE answers 202 on the first time and on the replay", async () => {
		const w = await wallet("10.00");
		const first = api.buildSubmit(w, "5.00", {
			kind: "WIN",
			reference: `never-sent-${uniqueId()}`,
		});

		const a = await api.request("POST", "/wagering/transactions", first);
		const b = await api.request("POST", "/wagering/transactions", first);

		expect(a.status).toBe(202);
		expect(a.body).toMatchObject({
			status: "PENDING_REFERENCE",
			failureCode: null,
			balance: { amount: "10.00", currency: "BRL" },
			idempotentReplay: false,
		});
		expect(b.status).toBe(202);
		expect(b.body).toMatchObject({
			status: "PENDING_REFERENCE",
			idempotentReplay: true,
		});
	});

	test("TST-I-06 FAILED replay answers 422 with balance null", async () => {
		const w = await wallet("10.00");
		const { body, headers } = api.buildSubmit(w, "5.00");
		// FAILED only comes out of the SQS exhaustion path (W9); here the row is written directly.
		await insertTransaction(sql, w.id, {
			provider_id: body.providerId,
			external_transaction_id: body.externalTransactionId,
			idempotency_key: headers["Idempotency-Key"],
			payload_hash: hashOf(body),
			player_id: w.playerId,
			round_id: body.roundId,
			game_id: body.gameId,
			status: "FAILED",
			failure_code: "PROCESSING_ATTEMPTS_EXHAUSTED",
			amount: "5.00",
		});

		const reply = await api.request("POST", "/wagering/transactions", {
			body,
			headers,
		});

		expect(reply.status).toBe(422);
		expect(reply.body).toMatchObject({
			status: "FAILED",
			failureCode: "PROCESSING_ATTEMPTS_EXHAUSTED",
			balance: null,
			idempotentReplay: true,
		});
	});
});

describe("TST-I-07 idempotency over HTTP", () => {
	test("TST-I-07 replay of a PROCESSED answers 200 with idempotentReplay and the balance observed back then", async () => {
		const w = await wallet("100.00");
		const first = api.buildSubmit(w, "30.00");
		const a = await api.request("POST", "/wagering/transactions", first);
		await api.submit(w, "10.00"); // moves the wallet on: 60.00

		const b = await api.request("POST", "/wagering/transactions", first);

		expect(a.status).toBe(201);
		expect(b.status).toBe(200);
		expect(b.body).toEqual({
			...a.body,
			idempotentReplay: true,
		});
		expect(b.body.balance.amount).toBe("70.00");
		expect(await api.balanceOf(w)).toBe("60.00");
	});

	test("TST-I-07 same key with a different payload is a 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH", async () => {
		const w = await wallet("100.00");
		const first = api.buildSubmit(w, "30.00");
		await api.request("POST", "/wagering/transactions", first);

		const reply = await api.request("POST", "/wagering/transactions", {
			body: { ...first.body, money: { amount: "31.00", currency: "BRL" } },
			headers: first.headers,
		});

		expectProblem(reply, 409, "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH", false);
		expect(await api.balanceOf(w)).toBe("70.00");
	});

	test("TST-I-07 external id reused with another key is a 409 EXTERNAL_TRANSACTION_ID_CONFLICT", async () => {
		const w = await wallet("100.00");
		const first = api.buildSubmit(w, "30.00");
		await api.request("POST", "/wagering/transactions", first);

		const reply = await api.request("POST", "/wagering/transactions", {
			body: first.body,
			headers: { "Idempotency-Key": `other-${uniqueId()}` },
		});

		expectProblem(reply, 409, "EXTERNAL_TRANSACTION_ID_CONFLICT", false);
		expect(await api.balanceOf(w)).toBe("70.00");
	});

	test("TST-I-07 a conflict is counted in idempotent_requests_total", async () => {
		const w = await wallet("100.00");
		const first = api.buildSubmit(w, "30.00");
		await api.request("POST", "/wagering/transactions", first);
		const before = await api.metric("idempotent_requests_total", {
			outcome: "conflict",
		});

		await api.request("POST", "/wagering/transactions", {
			body: first.body,
			headers: { "Idempotency-Key": `other-${uniqueId()}` },
		});

		expect(
			await api.metric("idempotent_requests_total", { outcome: "conflict" }),
		).toBe(before + 1);
	});
});

describe("TST-I-06 request validation (400)", () => {
	async function expectInvalid(
		mutate: (body: Record<string, unknown>) => void,
		errorCode = "VALIDATION_ERROR",
	) {
		const w = await wallet("100.00");
		const { body, headers } = api.buildSubmit(w, "10.00");
		mutate(body as unknown as Record<string, unknown>);
		const reply = await api.request("POST", "/wagering/transactions", {
			body,
			headers,
		});
		expectProblem(reply, 400, errorCode, false);
		expect(await api.balanceOf(w)).toBe("100.00");
	}

	test("TST-I-06 missing Idempotency-Key is 400 MISSING_IDEMPOTENCY_KEY", async () => {
		const w = await wallet("100.00");
		const { body } = api.buildSubmit(w, "10.00");

		const reply = await api.request("POST", "/wagering/transactions", { body });

		expectProblem(reply, 400, "MISSING_IDEMPOTENCY_KEY", false);
	});

	test.each([
		["empty", ""],
		["256 characters", "k".repeat(256)],
		["non-ASCII", "chave-ação"],
		["control character", "a\tb"],
	])(
		"TST-I-06 Idempotency-Key %s is 400 MISSING_IDEMPOTENCY_KEY",
		async (_n, key) => {
			const w = await wallet("100.00");
			const { body } = api.buildSubmit(w, "10.00");

			const reply = await api.request("POST", "/wagering/transactions", {
				body,
				headers: { "Idempotency-Key": key },
			});

			expectProblem(reply, 400, "MISSING_IDEMPOTENCY_KEY", false);
		},
	);

	test("TST-I-06 a 255-character Idempotency-Key is accepted", async () => {
		const w = await wallet("100.00");
		const reply = await api.submit(w, "10.00", { key: "k".repeat(255) });
		expect(reply.status).toBe(201);
	});

	test("TST-I-06 OPENING is 400", () =>
		expectInvalid((b) => {
			b.kind = "OPENING";
		}));

	test("TST-I-06 unknown kind is 400", () =>
		expectInvalid((b) => {
			b.kind = "TIP";
		}));

	test.each([
		["zero", "0.00"],
		["negative", "-5.00"],
		["no decimals", "10"],
		["one decimal", "10.5"],
		["three decimals", "10.001"],
		["scientific", "1e3"],
		["18 integer digits", "123456789012345678.00"],
		["leading plus", "+10.00"],
	])("TST-I-06 amount %s is 400", (_n, amount) =>
		expectInvalid((b) => {
			b.money = { amount, currency: "BRL" };
		}),
	);

	test("TST-I-06 amount as a JSON number is 400", () =>
		expectInvalid((b) => {
			b.money = { amount: 10, currency: "BRL" };
		}));

	test("TST-I-06 lowercase currency is 400", () =>
		expectInvalid((b) => {
			b.money = { amount: "10.00", currency: "brl" };
		}));

	test("TST-I-06 an unknown extra field is 400", () =>
		expectInvalid((b) => {
			b.bonus = "1.00";
		}));

	test("TST-I-06 an unknown extra field inside money is 400", () =>
		expectInvalid((b) => {
			b.money = { amount: "10.00", currency: "BRL", fee: "1.00" };
		}));

	test.each(["playerId", "walletId"])(
		"TST-I-06 %s that is not a UUID is 400",
		(field) =>
			expectInvalid((b) => {
				b[field] = "not-a-uuid";
			}),
	);

	test.each(["providerId", "externalTransactionId", "roundId", "gameId"])(
		"TST-I-06 %s empty or longer than 128 is 400",
		async (field) => {
			await expectInvalid((b) => {
				b[field] = "";
			});
			await expectInvalid((b) => {
				b[field] = "x".repeat(129);
			});
		},
	);

	test("TST-I-06 a missing required field is 400", () =>
		expectInvalid((b) => {
			delete b.roundId;
		}));

	test("TST-I-06 BET with a reference is 400", () =>
		expectInvalid((b) => {
			b.referenceExternalTransactionId = "ext-1";
		}));

	test.each(["REFUND", "ROLLBACK"])(
		"TST-I-06 %s without a reference is 400",
		(kind) =>
			expectInvalid((b) => {
				b.kind = kind;
			}),
	);

	test("TST-I-06 a body that is not JSON is 400 VALIDATION_ERROR", async () => {
		const reply = await api.request("POST", "/wagering/transactions", {
			body: "{not json",
			headers: { "Idempotency-Key": "k-1" },
		});
		expectProblem(reply, 400, "VALIDATION_ERROR", false);
	});
});

describe("TST-I-06 404, 503 and the problem+json contract", () => {
	test("TST-I-06 unknown wallet is 404 WALLET_NOT_FOUND", async () => {
		const ghost: TestWallet = {
			id: uniqueId(),
			playerId: uniqueId(),
			currency: "BRL",
		};

		const reply = await api.submit(ghost, "10.00");

		expectProblem(reply, 404, "WALLET_NOT_FOUND", false);
	});

	test("TST-I-06 a real lock_timeout is 503 with Retry-After, counted, and the same key succeeds afterwards", async () => {
		const w = await wallet("100.00");
		const submission = api.buildSubmit(w, "10.00");
		const holder = await connect(db.url);
		const before = await api.metric("lock_conflicts_total", {
			type: "lock_timeout",
		});
		await holder.query("begin");
		await holder.query("select id from wallets where id = $1 for update", [
			w.id,
		]);
		let reply: Awaited<ReturnType<HttpApp["request"]>>;
		try {
			reply = await api.request("POST", "/wagering/transactions", submission);
		} finally {
			await holder.query("rollback");
			await holder.end();
		}

		expectProblem(reply, 503, "SERVICE_UNAVAILABLE", true);
		expect(reply.headers.get("retry-after")).toBe("1");
		expect(
			await api.metric("lock_conflicts_total", { type: "lock_timeout" }),
		).toBe(before + 1);
		const retry = await api.request(
			"POST",
			"/wagering/transactions",
			submission,
		);
		expect(retry.status).toBe(201);
		expect(retry.body.idempotentReplay).toBe(false);
		expect(await api.balanceOf(w)).toBe("90.00");
	});

	test("TST-I-06 the error body never exposes SQL, stack or driver text", async () => {
		const w = await wallet("100.00");
		const { body, headers } = api.buildSubmit(w, "10.00");
		const replies = [
			await api.request("POST", "/wagering/transactions", { body }),
			await api.request("POST", "/wagering/transactions", {
				body: { ...body, kind: "OPENING" },
				headers,
			}),
		];
		for (const reply of replies) {
			expect(JSON.stringify(reply.body)).not.toMatch(
				/select |insert |stack| at \/|constraint/i,
			);
		}
	});
});

describe("TST-I-06 X-Correlation-Id on the transaction route", () => {
	test("TST-I-06 the id received comes back on 2xx and 4xx and shows in the logs", async () => {
		const w = await wallet("100.00");
		const ok = await api.submit(w, "10.00", {
			headers: { "X-Correlation-Id": "corr-w7-ok" },
		});
		const bad = await api.request("POST", "/wagering/transactions", {
			body: { nonsense: true },
			headers: { "Idempotency-Key": "k-1", "X-Correlation-Id": "corr-w7-bad" },
		});

		expect(ok.headers.get("x-correlation-id")).toBe("corr-w7-ok");
		expect(bad.headers.get("x-correlation-id")).toBe("corr-w7-bad");
		expect(bad.body.correlationId).toBe("corr-w7-bad");
		const lines = await eventually(() => {
			const parsed = api.process
				.stdout()
				.split("\n")
				.filter((line) => line.startsWith("{"))
				.map((line) => JSON.parse(line) as Record<string, unknown>)
				.filter((line) => line.correlationId === "corr-w7-ok");
			return parsed.some((l) => l.msg === "wager transaction concluded") &&
				parsed.some((l) => l.msg === "request completed")
				? parsed
				: false;
		});
		const concluded = lines.find(
			(l) => l.msg === "wager transaction concluded",
		);
		expect(concluded).toMatchObject({
			walletId: w.id,
			kind: "BET",
			status: "PROCESSED",
		});
		expect(JSON.stringify(lines)).not.toContain(w.playerId);
	});
});
