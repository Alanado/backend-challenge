import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Client } from "pg";
import { appModule } from "../../src/app.module";
import { payloadHash } from "../../src/modules/wagering/domain/payload-hash";
import { WagerTransactionKind } from "../../src/modules/wagering/domain/wager-transaction-kind";
import { CreateWallet } from "../../src/modules/wallet/application/create-wallet";
import type { LedgerRepository } from "../../src/modules/wallet/application/ledger-repository";
import type { WalletLedgerEntry } from "../../src/modules/wallet/domain/wallet-ledger-entry";
import { SystemClock } from "../../src/shared/clock";
import { loadConfig } from "../../src/shared/config";
import { Uuidv7Generator } from "../../src/shared/ids";
import { Money } from "../../src/shared/money";
import { assertLedgerInvariant } from "../support/assertLedgerInvariant";
import { uniqueId } from "../support/ids";
import { createPersistence, type Persistence } from "../support/persistence";
import { connect } from "../support/sql";
import {
	createSuiteDatabase,
	type SuiteDatabase,
} from "../support/suite-database";

let db: SuiteDatabase;
let app: INestApplication;
let base: string;
let sql: Client;
let p: Persistence;

beforeAll(async () => {
	db = await createSuiteDatabase();
	const config = loadConfig({
		DATABASE_URL: db.url,
		ENABLE_CONSUMER: "false",
		ENABLE_OUTBOX_PUBLISHER: "false",
		ENABLE_PENDING_WORKER: "false",
		LOG_LEVEL: "error",
	});
	app = await NestFactory.create(appModule(config), { logger: false });
	await app.listen(0, "127.0.0.1");
	base = await app.getUrl();
	sql = await connect(db.url);
	p = await createPersistence(db.url);
});

afterAll(async () => {
	await p.close();
	await sql.end();
	await app.close();
	await db.drop();
});

interface Posted {
	status: number;
	headers: Headers;
	body: Record<string, unknown>;
}

async function post(
	body: unknown,
	headers: Record<string, string> = {},
): Promise<Posted> {
	const response = await fetch(`${base}/wallets`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
	return {
		status: response.status,
		headers: response.headers,
		body: (await response.json()) as Record<string, unknown>,
	};
}

async function get(path: string): Promise<Posted> {
	const response = await fetch(`${base}${path}`);
	return {
		status: response.status,
		headers: response.headers,
		body: (await response.json()) as Record<string, unknown>,
	};
}

const newBody = (amount: string, playerId = uniqueId(), currency = "BRL") => ({
	playerId,
	initialBalance: { amount, currency },
});

async function rows(text: string, params: unknown[]) {
	return (await sql.query(text, params)).rows as Record<string, unknown>[];
}

const countsFor = async (walletId: string) => ({
	wallets: (await rows("select 1 from wallets where id = $1", [walletId]))
		.length,
	transactions: (
		await rows("select 1 from wager_transactions where wallet_id = $1", [
			walletId,
		])
	).length,
	ledger: (
		await rows("select 1 from wallet_ledger_entries where wallet_id = $1", [
			walletId,
		])
	).length,
	outbox: (
		await rows("select 1 from outbox_messages where aggregate_id = $1", [
			walletId,
		])
	).length,
});

const countsForPlayer = async (playerId: string) => ({
	wallets: (
		await rows("select 1 from wallets where player_id = $1", [playerId])
	).length,
	transactions: (
		await rows("select 1 from wager_transactions where player_id = $1", [
			playerId,
		])
	).length,
});

describe("TST-I-19 creating a wallet with an initial balance", () => {
	test("TST-I-19 answers 201 with id, playerId, balance and version 1", async () => {
		const body = newBody("100.00");

		const created = await post(body, { "X-Correlation-Id": "corr-create-1" });

		expect(created.status).toBe(201);
		expect(created.headers.get("x-correlation-id")).toBe("corr-create-1");
		expect(created.body).toEqual({
			id: expect.stringMatching(/^[0-9a-f-]{36}$/),
			playerId: body.playerId,
			balance: { amount: "100.00", currency: "BRL" },
			version: 1,
		});
		await assertLedgerInvariant(p.ledgerIntegrity, created.body.id as string);
	});

	test("TST-I-19 writes wallet, OPENING transaction, CREDIT ledger entry and the event together", async () => {
		const body = newBody("250.50");
		const created = await post(body, { "X-Correlation-Id": "corr-create-2" });
		const walletId = created.body.id as string;

		expect(await countsFor(walletId)).toEqual({
			wallets: 1,
			transactions: 1,
			ledger: 1,
			outbox: 1,
		});

		const [wallet] = await rows("select * from wallets where id = $1", [
			walletId,
		]);
		expect(wallet).toMatchObject({
			player_id: body.playerId,
			currency: "BRL",
			balance: "250.50",
			version: 1,
		});

		const [opening] = await rows(
			"select * from wager_transactions where wallet_id = $1",
			[walletId],
		);
		expect(opening).toMatchObject({
			provider_id: "system",
			external_transaction_id: `opening:${walletId}`,
			idempotency_key: `opening:${walletId}`,
			kind: "OPENING",
			status: "PROCESSED",
			amount: "250.50",
			currency: "BRL",
			observed_balance: "250.50",
			round_id: "opening",
			game_id: "system",
			player_id: body.playerId,
			reference_external_transaction_id: null,
			failure_code: null,
		});
		expect(opening?.processed_at).toBeInstanceOf(Date);
		expect(opening?.payload_hash).toBe(
			payloadHash({
				providerId: "system",
				externalTransactionId: `opening:${walletId}`,
				playerId: body.playerId,
				walletId,
				roundId: "opening",
				gameId: "system",
				kind: WagerTransactionKind.Opening,
				money: Money.from({ amount: "250.50", currency: "BRL" }),
			}),
		);

		const [entry] = await rows(
			"select * from wallet_ledger_entries where wallet_id = $1",
			[walletId],
		);
		expect(entry).toMatchObject({
			transaction_id: opening?.id,
			wallet_version: 1,
			direction: "CREDIT",
			amount: "250.50",
			currency: "BRL",
			balance_before: "0.00",
			balance_after: "250.50",
		});
		await assertLedgerInvariant(p.ledgerIntegrity, walletId);
	});

	test("TST-I-19 the only event is WalletBalanceChanged, with the agreed content", async () => {
		const created = await post(newBody("80.00"), {
			"X-Correlation-Id": "corr-event-1",
		});
		const walletId = created.body.id as string;

		const events = await rows(
			"select * from outbox_messages where aggregate_id = $1",
			[walletId],
		);

		expect(events).toHaveLength(1);
		const [event] = events;
		const [opening] = await rows(
			"select id from wager_transactions where wallet_id = $1",
			[walletId],
		);
		expect(event).toMatchObject({
			id: expect.any(String),
			aggregate_id: walletId,
			group_key: walletId,
			event_type: "WalletBalanceChanged",
			published_at: null,
		});
		expect(event?.payload).toMatchObject({
			eventId: event?.id,
			eventType: "WalletBalanceChanged",
			aggregateId: walletId,
			correlationId: "corr-event-1",
			causationId: opening?.id,
			version: 1,
			data: {
				walletId,
				transactionId: opening?.id,
				direction: "CREDIT",
				money: { amount: "80.00", currency: "BRL" },
				balanceBefore: { amount: "0.00", currency: "BRL" },
				balanceAfter: { amount: "80.00", currency: "BRL" },
				walletVersion: 1,
			},
		});
	});

	test("TST-I-19 GET /wallets/:id returns the wallet that was created", async () => {
		const body = newBody("12.34");
		const created = await post(body);

		const fetched = await get(`/wallets/${created.body.id}`);

		expect(fetched.status).toBe(200);
		expect(fetched.body).toEqual(created.body);
	});
});

describe("TST-I-19 creating a wallet with a zero initial balance", () => {
	test("TST-I-19 is valid: version 1, and no OPENING, no ledger entry, no event", async () => {
		const body = newBody("0.00");

		const created = await post(body);

		expect(created.status).toBe(201);
		expect(created.body).toMatchObject({
			playerId: body.playerId,
			balance: { amount: "0.00", currency: "BRL" },
			version: 1,
		});
		const walletId = created.body.id as string;
		expect(await countsFor(walletId)).toEqual({
			wallets: 1,
			transactions: 0,
			ledger: 0,
			outbox: 0,
		});
		await assertLedgerInvariant(p.ledgerIntegrity, walletId);
	});
});

describe("TST-I-19 duplicate wallets", () => {
	test("TST-I-19 the same player and currency again is 409 WALLET_ALREADY_EXISTS and leaves nothing behind", async () => {
		const playerId = uniqueId();
		const first = await post(newBody("10.00", playerId));
		expect(first.status).toBe(201);

		const second = await post(newBody("99.00", playerId), {
			"X-Correlation-Id": "corr-dup",
		});

		expect(second.status).toBe(409);
		expect(second.headers.get("content-type")).toContain(
			"application/problem+json",
		);
		expect(second.body).toMatchObject({
			type: "about:blank",
			status: 409,
			errorCode: "WALLET_ALREADY_EXISTS",
			correlationId: "corr-dup",
			retryable: false,
		});
		expect(typeof second.body.title).toBe("string");
		expect(typeof second.body.detail).toBe("string");
		expect(await countsForPlayer(playerId)).toEqual({
			wallets: 1,
			transactions: 1,
		});
		const [stored] = await rows(
			"select balance, version from wallets where player_id = $1",
			[playerId],
		);
		expect(stored).toMatchObject({ balance: "10.00", version: 1 });
		await assertLedgerInvariant(p.ledgerIntegrity, first.body.id as string);
	});

	test("TST-I-19 the same player in another currency is a different wallet", async () => {
		const playerId = uniqueId();

		const brl = await post(newBody("10.00", playerId, "BRL"));
		const usd = await post(newBody("10.00", playerId, "USD"));

		expect(brl.status).toBe(201);
		expect(usd.status).toBe(201);
		expect(usd.body.id).not.toBe(brl.body.id);
	});

	test("TST-I-19 simultaneous creations: exactly one 201, the rest 409, one set of rows", async () => {
		for (let round = 0; round < 3; round++) {
			const playerId = uniqueId();

			const results = await Promise.all(
				Array.from({ length: 6 }, () => post(newBody("5.00", playerId))),
			);

			const created = results.filter((r) => r.status === 201);
			const conflicts = results.filter((r) => r.status === 409);
			expect(created).toHaveLength(1);
			expect(conflicts).toHaveLength(5);
			for (const conflict of conflicts) {
				expect(conflict.body.errorCode).toBe("WALLET_ALREADY_EXISTS");
			}
			expect(await countsForPlayer(playerId)).toEqual({
				wallets: 1,
				transactions: 1,
			});
			const walletId = created[0]?.body.id as string;
			expect(await countsFor(walletId)).toEqual({
				wallets: 1,
				transactions: 1,
				ledger: 1,
				outbox: 1,
			});
			await assertLedgerInvariant(p.ledgerIntegrity, walletId);
		}
	});
});

describe("TST-I-19 validation", () => {
	const player = uniqueId();
	const invalid: [string, unknown][] = [
		["negative amount", newBody("-1.00", player)],
		["scale 1", newBody("10.0", player)],
		["scale 3", newBody("10.000", player)],
		["no decimals", newBody("10", player)],
		["scientific notation", newBody("1e3", player)],
		["thousands separator", newBody("1,000.00", player)],
		["more than 17 integer digits", newBody("123456789012345678.00", player)],
		[
			"amount as a JSON number",
			{
				playerId: player,
				initialBalance: { amount: 10, currency: "BRL" },
			},
		],
		["lowercase currency", newBody("10.00", player, "brl")],
		["two-letter currency", newBody("10.00", player, "BR")],
		["playerId not a uuid", newBody("10.00", "not-a-uuid")],
		[
			"missing playerId",
			{ initialBalance: { amount: "1.00", currency: "BRL" } },
		],
		["missing initialBalance", { playerId: player }],
		["unknown field", { ...newBody("10.00", player), extra: true }],
		[
			"unknown field inside initialBalance",
			{
				playerId: player,
				initialBalance: { amount: "1.00", currency: "BRL", note: "x" },
			},
		],
		["empty object", {}],
		["array body", []],
		["malformed JSON", "{not json"],
	];

	test.each(invalid)(
		"TST-I-19 %s is 400 VALIDATION_ERROR and creates nothing",
		async (_name, body) => {
			const response = await post(body, { "X-Correlation-Id": "corr-invalid" });

			expect(response.status).toBe(400);
			expect(response.headers.get("content-type")).toContain(
				"application/problem+json",
			);
			expect(response.body).toMatchObject({
				type: "about:blank",
				status: 400,
				errorCode: "VALIDATION_ERROR",
				correlationId: "corr-invalid",
				retryable: false,
			});
			expect((await countsForPlayer(player)).wallets).toBe(0);
		},
	);

	test("TST-I-19 GET with a malformed wallet id is 400 VALIDATION_ERROR", async () => {
		const response = await get("/wallets/not-a-uuid");
		expect(response.status).toBe(400);
		expect(response.body.errorCode).toBe("VALIDATION_ERROR");
	});
});

describe("TST-I-19 GET /wallets/:id for a wallet that does not exist", () => {
	test("TST-I-19 is 404 WALLET_NOT_FOUND as problem+json", async () => {
		const response = await get(`/wallets/${uniqueId()}`);

		expect(response.status).toBe(404);
		expect(response.headers.get("content-type")).toContain(
			"application/problem+json",
		);
		expect(response.body).toMatchObject({
			type: "about:blank",
			status: 404,
			errorCode: "WALLET_NOT_FOUND",
			retryable: false,
		});
		expect(response.body.correlationId).toBe(
			response.headers.get("x-correlation-id"),
		);
	});
});

describe("TST-I-19 the creation is one SQL transaction (real PostgreSQL, failure injected on top)", () => {
	function createWithFailingLedger(): CreateWallet {
		const failingLedger: LedgerRepository = {
			append: async (_entry: WalletLedgerEntry) => {
				throw new Error("injected: ledger write failed");
			},
			findByWallet: (walletId) => p.ledger.findByWallet(walletId),
			findPage: (walletId, page) => p.ledger.findPage(walletId, page),
		};
		return new CreateWallet(
			p.tm,
			p.wallets,
			p.transactions,
			failingLedger,
			p.outbox,
			new SystemClock(),
			new Uuidv7Generator(),
		);
	}

	test("TST-I-19 a failure between the OPENING and the ledger entry rolls everything back", async () => {
		const playerId = uniqueId();

		await expect(
			createWithFailingLedger().execute({
				playerId,
				initialBalance: { amount: "40.00", currency: "BRL" },
				correlationId: "corr-atomic",
			}),
		).rejects.toThrow("injected: ledger write failed");

		expect(await countsForPlayer(playerId)).toEqual({
			wallets: 0,
			transactions: 0,
		});
		const events = await rows(
			"select 1 from outbox_messages where payload->>'correlationId' = $1",
			["corr-atomic"],
		);
		expect(events).toHaveLength(0);
	});

	test("TST-I-19 after such a failure the same player can still create the wallet", async () => {
		const playerId = uniqueId();
		await expect(
			createWithFailingLedger().execute({
				playerId,
				initialBalance: { amount: "40.00", currency: "BRL" },
				correlationId: "corr-atomic-2",
			}),
		).rejects.toThrow();

		const retry = await post(newBody("40.00", playerId));

		expect(retry.status).toBe(201);
		await assertLedgerInvariant(p.ledgerIntegrity, retry.body.id as string);
	});
});
