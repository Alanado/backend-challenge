import { Client } from "pg";
import { uniqueId } from "./ids";

export async function connect(url: string): Promise<Client> {
	const client = new Client({ connectionString: url });
	await client.connect();
	return client;
}

export interface PgFailure {
	code: string;
	constraint?: string;
	message: string;
}

/** Runs `work` and returns the PostgreSQL error it raised; fails the test if it did not raise. */
export async function failureOf(work: Promise<unknown>): Promise<PgFailure> {
	try {
		await work;
	} catch (err) {
		const e = err as { code?: string; constraint?: string; message: string };
		return {
			code: e.code ?? "(none)",
			constraint: e.constraint,
			message: e.message,
		};
	}
	throw new Error("expected the statement to fail, but it succeeded");
}

export const UNIQUE_VIOLATION = "23505";
export const CHECK_VIOLATION = "23514";
export const FK_VIOLATION = "23503";
export const NOT_NULL_VIOLATION = "23502";
// Default SQLSTATE of RAISE EXCEPTION (the triggers of 02-design §4).
export const RAISE_EXCEPTION = "P0001";

type Row = Record<string, unknown>;

async function insert(client: Client, table: string, row: Row): Promise<Row> {
	const columns = Object.keys(row);
	const res = await client.query(
		`insert into ${table} (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
		columns.map((c) => row[c]),
	);
	return res.rows[0] as Row;
}

/** A valid wallet row; every call gets fresh ids, so tests never collide and never need cleanup. */
export function insertWallet(
	client: Client,
	overrides: Row = {},
): Promise<Row> {
	return insert(client, "wallets", {
		id: uniqueId(),
		player_id: uniqueId(),
		currency: "BRL",
		balance: "100.00",
		version: 1,
		created_at: new Date(),
		updated_at: new Date(),
		...overrides,
	});
}

/** A valid PENDING BET against `walletId`; `overrides` change any column. */
export function insertTransaction(
	client: Client,
	walletId: string,
	overrides: Row = {},
): Promise<Row> {
	const now = new Date();
	return insert(client, "wager_transactions", {
		id: uniqueId(),
		provider_id: "provider-a",
		external_transaction_id: `ext-${uniqueId()}`,
		idempotency_key: `idem-${uniqueId()}`,
		payload_hash: "hash",
		wallet_id: walletId,
		player_id: uniqueId(),
		round_id: "round-1",
		game_id: "game-1",
		kind: "BET",
		amount: "10.00",
		currency: "BRL",
		status: "PENDING",
		created_at: now,
		updated_at: now,
		...overrides,
	});
}

/** A valid CREDIT ledger entry (version 2, 100.00 -> 110.00) for `transactionId`; `overrides` change any column. */
export function insertLedgerEntry(
	client: Client,
	walletId: string,
	transactionId: string,
	overrides: Row = {},
): Promise<Row> {
	return insert(client, "wallet_ledger_entries", {
		id: uniqueId(),
		wallet_id: walletId,
		transaction_id: transactionId,
		wallet_version: 2,
		direction: "CREDIT",
		amount: "10.00",
		currency: "BRL",
		balance_before: "100.00",
		balance_after: "110.00",
		created_at: new Date(),
		...overrides,
	});
}
