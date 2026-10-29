import type { Client } from "pg";
import { assertLedgerInvariant } from "../../support/assertLedgerInvariant";
import type { Persistence } from "../../support/persistence";
import { connect } from "../../support/sql";
import {
	LatencyRecorder,
	type LatencySummary,
	throughput,
} from "./measurement";

/**
 * ADR-0006 alternatives A and C as plain SQL on the real `wallets` / `wager_transactions` /
 * `wallet_ledger_entries` tables (ADR-0021). No HTTP, outbox, inbox, references or states: this
 * compares how two ways of taking the row lock behave under 50 clients on one wallet, nothing more.
 * Both variants write the same ledger entry and the same `wager_transactions` row in the same
 * transaction, in the lock order of ADR-0007 (wallet first, then the transaction row).
 */
export type Strategy = "A" | "C";

type AttemptResult =
	| "accepted"
	| "rejected"
	| "version_conflict"
	| "lock_timeout"
	| "deadlock"
	| "error";

export interface StrategyOptions {
	url: string;
	clients: number;
	attemptsPerClient: number;
	/** Debit amount, decimal string. */
	amount: string;
	/** Share of attempts the initial balance can pay, in percent (the rest is rejected for funds). */
	fundedPercent: number;
}

export interface StrategyResult {
	strategy: Strategy;
	walletId: string;
	clients: number;
	attempts: number;
	accepted: number;
	rejected: number;
	versionConflicts: number;
	lockTimeouts: number;
	deadlocks: number;
	otherErrors: number;
	elapsedMs: number;
	attemptsPerSecond: number;
	latency: LatencySummary;
	initialBalance: string;
	finalBalance: string;
	ledgerDebits: number;
	processedRows: number;
	rejectedRows: number;
	violations: string[];
}

async function insertTransaction(
	c: Client,
	walletId: string,
	playerId: string,
	transactionId: string,
	amount: string,
	rejected: boolean,
): Promise<void> {
	await c.query(
		`insert into wager_transactions
		   (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
		    player_id, round_id, game_id, kind, amount, currency, status, failure_code,
		    created_at, processed_at, updated_at)
		 values ($1::uuid, 'bench', $1::uuid::text, $1::uuid::text, 'bench', $2, $3, 'round', 'game', 'BET', $4::numeric,
		         'BRL', $5, $6, now(), $7, now())`,
		[
			transactionId,
			walletId,
			playerId,
			amount,
			rejected ? "REJECTED" : "PROCESSED",
			rejected ? "INSUFFICIENT_FUNDS" : null,
			rejected ? null : new Date(),
		],
	);
}

async function insertLedger(
	c: Client,
	walletId: string,
	transactionId: string,
	version: number,
	balanceAfter: string,
	amount: string,
): Promise<void> {
	await c.query(
		`insert into wallet_ledger_entries
		   (id, wallet_id, transaction_id, wallet_version, direction, amount, currency,
		    balance_before, balance_after, created_at)
		 values ($1, $2, $3, $4, 'DEBIT', $5::numeric, 'BRL', $6::numeric + $5::numeric, $6::numeric, now())`,
		[
			crypto.randomUUID(),
			walletId,
			transactionId,
			version,
			amount,
			balanceAfter,
		],
	);
}

async function debitA(
	c: Client,
	walletId: string,
	playerId: string,
	amount: string,
): Promise<AttemptResult> {
	const transactionId = crypto.randomUUID();
	await c.query("begin");
	const row = await c.query(
		`select version, balance >= $2::numeric as enough
		   from wallets where id = $1 for update`,
		[walletId, amount],
	);
	if (row.rows[0].enough !== true) {
		await insertTransaction(c, walletId, playerId, transactionId, amount, true);
		await c.query("commit");
		return "rejected";
	}
	const version = Number(row.rows[0].version);
	const updated = await c.query(
		`update wallets set balance = balance - $2::numeric, version = version + 1, updated_at = now()
		  where id = $1 and version = $3 returning balance`,
		[walletId, amount, version],
	);
	if (updated.rowCount === 0) {
		await c.query("rollback");
		return "version_conflict";
	}
	await insertTransaction(c, walletId, playerId, transactionId, amount, false);
	await insertLedger(
		c,
		walletId,
		transactionId,
		version + 1,
		String(updated.rows[0].balance),
		amount,
	);
	await c.query("commit");
	return "accepted";
}

async function debitC(
	c: Client,
	walletId: string,
	playerId: string,
	amount: string,
): Promise<AttemptResult> {
	const transactionId = crypto.randomUUID();
	await c.query("begin");
	const updated = await c.query(
		`update wallets set balance = balance - $2::numeric, version = version + 1, updated_at = now()
		  where id = $1 and balance >= $2::numeric returning balance, version`,
		[walletId, amount],
	);
	if (updated.rowCount === 0) {
		await insertTransaction(c, walletId, playerId, transactionId, amount, true);
		await c.query("commit");
		return "rejected";
	}
	await insertTransaction(c, walletId, playerId, transactionId, amount, false);
	await insertLedger(
		c,
		walletId,
		transactionId,
		Number(updated.rows[0].version),
		String(updated.rows[0].balance),
		amount,
	);
	await c.query("commit");
	return "accepted";
}

async function attempt(
	c: Client,
	strategy: Strategy,
	walletId: string,
	playerId: string,
	amount: string,
): Promise<AttemptResult> {
	try {
		return await (strategy === "A" ? debitA : debitC)(
			c,
			walletId,
			playerId,
			amount,
		);
	} catch (error) {
		await c.query("rollback").catch(() => undefined);
		const code = (error as { code?: string }).code;
		if (code === "55P03") return "lock_timeout";
		if (code === "40P01") return "deadlock";
		return "error";
	}
}

export async function runStrategy(
	strategy: Strategy,
	options: StrategyOptions,
	p: Persistence,
): Promise<StrategyResult> {
	const attempts = options.clients * options.attemptsPerClient;
	const admin = await connect(options.url);
	const walletId = crypto.randomUUID();
	const playerId = crypto.randomUUID();
	const funded = Math.floor((attempts * options.fundedPercent) / 100);
	// initial = amount * funded, computed by the database (no JS arithmetic on money).
	const initial = await admin.query(
		"select ($1::numeric * $2::int)::text as v",
		[options.amount, funded],
	);
	const initialBalance = String(initial.rows[0].v);
	await admin.query(
		`insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
		 values ($1, $2, 'BRL', $3::numeric, 1, now(), now())`,
		[walletId, playerId, initialBalance],
	);

	// The opening entry, as the API writes it: OPENING transaction + CREDIT at version 1.
	const openingId = crypto.randomUUID();
	await admin.query(
		`insert into wager_transactions
		   (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
		    player_id, round_id, game_id, kind, amount, currency, status, created_at, processed_at, updated_at)
		 values ($1::uuid, 'bench', $1::uuid::text, $1::uuid::text, 'bench', $2, $3, 'round', 'game', 'OPENING',
		         $4::numeric, 'BRL', 'PROCESSED', now(), now(), now())`,
		[openingId, walletId, playerId, initialBalance],
	);
	await admin.query(
		`insert into wallet_ledger_entries
		   (id, wallet_id, transaction_id, wallet_version, direction, amount, currency,
		    balance_before, balance_after, created_at)
		 values ($1, $2, $3, 1, 'CREDIT', $4::numeric, 'BRL', 0, $4::numeric, now())`,
		[crypto.randomUUID(), walletId, openingId, initialBalance],
	);

	const connections = await Promise.all(
		Array.from({ length: options.clients }, async () => {
			const c = await connect(options.url);
			await c.query("set lock_timeout = '5s'; set statement_timeout = '15s'");
			return c;
		}),
	);
	const counts: Record<AttemptResult, number> = {
		accepted: 0,
		rejected: 0,
		version_conflict: 0,
		lock_timeout: 0,
		deadlock: 0,
		error: 0,
	};
	const latency = new LatencyRecorder();
	const startedAt = performance.now();
	try {
		await Promise.all(
			connections.map(async (c) => {
				for (let i = 0; i < options.attemptsPerClient; i++) {
					const begin = performance.now();
					const result = await attempt(
						c,
						strategy,
						walletId,
						playerId,
						options.amount,
					);
					latency.record(performance.now() - begin);
					counts[result]++;
				}
			}),
		);
	} finally {
		await Promise.all(connections.map((c) => c.end()));
	}
	const elapsedMs = performance.now() - startedAt;

	const final = await admin.query(
		"select balance::text as balance from wallets where id = $1",
		[walletId],
	);
	const finalBalance = String(final.rows[0].balance);
	const ledger = await admin.query(
		"select count(*)::int as n from wallet_ledger_entries where wallet_id = $1 and direction = 'DEBIT'",
		[walletId],
	);
	const rows = await admin.query(
		`select count(*) filter (where status = 'PROCESSED')::int as processed,
		        count(*) filter (where status = 'REJECTED')::int as rejected
		   from wager_transactions where wallet_id = $1 and kind = 'BET'`,
		[walletId],
	);
	const expected = await admin.query(
		"select ($1::numeric - $2::numeric * $3::int)::text as v",
		[initialBalance, options.amount, counts.accepted],
	);

	const violations: string[] = [];
	if (finalBalance !== String(expected.rows[0].v)) {
		violations.push(
			`final balance ${finalBalance} != initial ${initialBalance} - accepted debits (${expected.rows[0].v})`,
		);
	}
	if (Number(finalBalance) < 0) violations.push("negative final balance");
	if (ledger.rows[0].n !== counts.accepted) {
		violations.push(
			`${ledger.rows[0].n} ledger entries for ${counts.accepted} accepted debits`,
		);
	}
	if (rows.rows[0].processed !== counts.accepted) {
		violations.push("processed rows differ from accepted debits");
	}
	if (rows.rows[0].rejected !== counts.rejected) {
		violations.push("rejected rows differ from rejected attempts");
	}
	try {
		await assertLedgerInvariant(p.ledgerIntegrity, walletId);
	} catch (error) {
		violations.push(error instanceof Error ? error.message : String(error));
	}
	await admin.end();

	return {
		strategy,
		walletId,
		clients: options.clients,
		attempts,
		accepted: counts.accepted,
		rejected: counts.rejected,
		versionConflicts: counts.version_conflict,
		lockTimeouts: counts.lock_timeout,
		deadlocks: counts.deadlock,
		otherErrors: counts.error,
		elapsedMs,
		attemptsPerSecond: throughput(attempts, elapsedMs),
		latency: latency.summarize(),
		initialBalance,
		finalBalance,
		ledgerDebits: ledger.rows[0].n,
		processedRows: rows.rows[0].processed,
		rejectedRows: rows.rows[0].rejected,
		violations,
	};
}
