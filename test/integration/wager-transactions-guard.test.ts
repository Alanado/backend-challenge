import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { uniqueId } from "../support/ids";
import {
	connect,
	failureOf,
	insertTransaction,
	insertWallet,
	RAISE_EXCEPTION,
} from "../support/sql";
import {
	createSuiteDatabase,
	type SuiteDatabase,
} from "../support/suite-database";

let db: SuiteDatabase;
let client: Client;
let walletId: string;

beforeAll(async () => {
	db = await createSuiteDatabase();
	client = await connect(db.url);
	walletId = (await insertWallet(client)).id as string;
});

afterAll(async () => {
	await client.end();
	await db.drop();
});

const TERMINAL: Array<[string, Record<string, unknown>]> = [
	["PROCESSED", { status: "PROCESSED", processed_at: new Date() }],
	["REJECTED", { status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" }],
	["FAILED", { status: "FAILED", failure_code: "INTERNAL_ERROR" }],
];

describe("TST-I-04 terminal wager_transactions are immutable", () => {
	test.each(TERMINAL)(
		"TST-I-04 UPDATE of a %s row fails",
		async (_status, overrides) => {
			const row = await insertTransaction(client, walletId, overrides);
			const failure = await failureOf(
				client.query(
					"update wager_transactions set updated_at = now() where id = $1",
					[row.id],
				),
			);
			expect(failure.code).toBe(RAISE_EXCEPTION);
			expect(failure.message).toContain(
				"terminal wager_transactions are immutable",
			);
		},
	);

	test.each(TERMINAL)(
		"TST-I-04 a %s row cannot be moved to another status either",
		async (_status, overrides) => {
			const row = await insertTransaction(client, walletId, overrides);
			const failure = await failureOf(
				client.query(
					"update wager_transactions set status = 'PENDING', failure_code = null, processed_at = null where id = $1",
					[row.id],
				),
			);
			expect(failure.message).toContain(
				"terminal wager_transactions are immutable",
			);
		},
	);

	test.each(TERMINAL)(
		"TST-I-04 DELETE of a %s row fails",
		async (_status, overrides) => {
			const row = await insertTransaction(client, walletId, overrides);
			const failure = await failureOf(
				client.query("delete from wager_transactions where id = $1", [row.id]),
			);
			expect(failure.code).toBe(RAISE_EXCEPTION);
			expect(failure.message).toContain("wager_transactions cannot be deleted");
		},
	);

	test("TST-I-04 DELETE fails for any row, including non terminal ones", async () => {
		for (const overrides of [
			{ status: "PENDING" },
			{
				kind: "REFUND",
				reference_external_transaction_id: "ext-r",
				status: "PENDING_REFERENCE",
				next_attempt_at: new Date(),
			},
		]) {
			const row = await insertTransaction(client, walletId, overrides);
			const failure = await failureOf(
				client.query("delete from wager_transactions where id = $1", [row.id]),
			);
			expect(failure.message).toContain("wager_transactions cannot be deleted");
		}
	});
});

describe("TST-I-04 identity columns are immutable on non terminal rows", () => {
	const identityChanges: Array<
		[string, string, () => unknown, Record<string, unknown>?]
	> = [
		["id", "id", () => uniqueId()],
		["provider_id", "provider_id", () => "provider-z"],
		[
			"external_transaction_id",
			"external_transaction_id",
			() => `ext-${uniqueId()}`,
		],
		["idempotency_key", "idempotency_key", () => `idem-${uniqueId()}`],
		["payload_hash", "payload_hash", () => "other-hash"],
		["wallet_id", "wallet_id", () => "__other_wallet__"],
		["player_id", "player_id", () => uniqueId()],
		["round_id", "round_id", () => "round-2"],
		["game_id", "game_id", () => "game-2"],
		["kind", "kind", () => "WIN"],
		["amount", "amount", () => "11.00"],
		["currency", "currency", () => "USD"],
		[
			"reference_external_transaction_id",
			"reference_external_transaction_id",
			() => "ext-other",
			{
				kind: "REFUND",
				reference_external_transaction_id: "ext-orig",
				status: "PENDING_REFERENCE",
				next_attempt_at: new Date(),
			},
		],
		["created_at", "created_at", () => new Date(0)],
	];

	test.each(identityChanges)(
		"TST-I-04 changing %s fails",
		async (_label, column, next, base = {}) => {
			const row = await insertTransaction(client, walletId, base);
			let value = next();
			if (value === "__other_wallet__") {
				value = (await insertWallet(client)).id;
			}
			const failure = await failureOf(
				client.query(
					`update wager_transactions set ${column} = $2 where id = $1`,
					[row.id, value],
				),
			);
			expect(failure.code).toBe(RAISE_EXCEPTION);
			expect(failure.message).toContain("identity columns are immutable");
		},
	);

	test("TST-I-04 a failed identity change leaves the row untouched", async () => {
		const row = await insertTransaction(client, walletId);
		await failureOf(
			client.query(
				"update wager_transactions set amount = '99.00' where id = $1",
				[row.id],
			),
		);
		const after = await client.query(
			"select amount from wager_transactions where id = $1",
			[row.id],
		);
		expect(after.rows[0].amount).toBe("10.00");
	});
});

describe("TST-I-04 legitimate updates on non terminal rows pass", () => {
	async function pendingReference(): Promise<string> {
		const row = await insertTransaction(client, walletId, {
			kind: "REFUND",
			reference_external_transaction_id: "ext-orig",
			status: "PENDING_REFERENCE",
			next_attempt_at: new Date(Date.now() + 1000),
		});
		return row.id as string;
	}

	test("TST-I-04 reference_attempts, next_attempt_at, observed_balance and updated_at can change", async () => {
		const id = await pendingReference();
		const later = new Date(Date.now() + 60_000);
		const res = await client.query(
			"update wager_transactions set reference_attempts = reference_attempts + 1, next_attempt_at = $2, observed_balance = '12.34', updated_at = $2 where id = $1 returning reference_attempts, observed_balance, status",
			[id, later],
		);
		expect(res.rows[0]).toEqual({
			reference_attempts: 1,
			observed_balance: "12.34",
			status: "PENDING_REFERENCE",
		});
	});

	test("TST-I-04 reference_transaction_id can be linked", async () => {
		const original = await insertTransaction(client, walletId, {
			status: "PROCESSED",
			processed_at: new Date(),
		});
		const id = await pendingReference();
		const res = await client.query(
			"update wager_transactions set reference_transaction_id = $2 where id = $1 returning reference_transaction_id",
			[id, original.id],
		);
		expect(res.rows[0].reference_transaction_id).toBe(original.id as string);
	});

	test("TST-I-04 PENDING_REFERENCE -> PROCESSED passes (status, processed_at, updated_at)", async () => {
		const id = await pendingReference();
		const res = await client.query(
			"update wager_transactions set status = 'PROCESSED', processed_at = now(), updated_at = now() where id = $1 returning status",
			[id],
		);
		expect(res.rows[0].status).toBe("PROCESSED");
	});

	test("TST-I-04 PENDING -> PROCESSED passes", async () => {
		const row = await insertTransaction(client, walletId);
		const res = await client.query(
			"update wager_transactions set status = 'PROCESSED', processed_at = now(), updated_at = now() where id = $1 returning status",
			[row.id],
		);
		expect(res.rows[0].status).toBe("PROCESSED");
	});

	test("TST-I-04 PENDING -> REJECTED passes (status, failure_code, observed_balance)", async () => {
		const row = await insertTransaction(client, walletId);
		const res = await client.query(
			"update wager_transactions set status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS', observed_balance = '1.00', updated_at = now() where id = $1 returning status, failure_code",
			[row.id],
		);
		expect(res.rows[0]).toEqual({
			status: "REJECTED",
			failure_code: "INSUFFICIENT_FUNDS",
		});
	});

	test("TST-I-04 PENDING_REFERENCE -> FAILED passes", async () => {
		const id = await pendingReference();
		const res = await client.query(
			"update wager_transactions set status = 'FAILED', failure_code = 'REFERENCE_NOT_FOUND', updated_at = now() where id = $1 returning status",
			[id],
		);
		expect(res.rows[0].status).toBe("FAILED");
	});

	test("TST-I-04 a no-op UPDATE on a non terminal row passes", async () => {
		const row = await insertTransaction(client, walletId);
		const res = await client.query(
			"update wager_transactions set updated_at = updated_at where id = $1",
			[row.id],
		);
		expect(res.rowCount).toBe(1);
	});
});
