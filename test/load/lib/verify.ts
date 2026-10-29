import type { Client } from "pg";
import { assertLedgerInvariant } from "../../support/assertLedgerInvariant";
import { eventually } from "../../support/eventually";
import { mapPool } from "../../support/multi-instance";
import type { Persistence } from "../../support/persistence";

export interface VerifyInput {
	p: Persistence;
	sql: Client;
	walletIds: readonly string[];
	/** When every operation of the scenario is a BET: expected balance = initial - Σ processed BETs. */
	betOnlyInitialBalance?: string;
}

/** Everything that must hold after a load run; returns the violations instead of throwing on the first. */
export async function verifyConsistency(input: VerifyInput): Promise<string[]> {
	const { p, sql, walletIds } = input;
	const ids = [...walletIds];
	const violations: string[] = [];

	await mapPool(ids, 8, async (id) => {
		try {
			await assertLedgerInvariant(p.ledgerIntegrity, id);
		} catch (error) {
			violations.push(error instanceof Error ? error.message : String(error));
		}
	});

	const negative = await sql.query(
		"select id from wallets where id = any($1::uuid[]) and balance < 0",
		[ids],
	);
	for (const row of negative.rows) {
		violations.push(`wallet ${row.id} has a negative balance`);
	}

	const duplicated = await sql.query(
		`select wallet_id, transaction_id from wallet_ledger_entries
		  where wallet_id = any($1::uuid[])
		  group by wallet_id, transaction_id having count(*) > 1`,
		[ids],
	);
	for (const row of duplicated.rows) {
		violations.push(
			`transaction ${row.transaction_id} has more than one ledger entry on wallet ${row.wallet_id}`,
		);
	}

	if (input.betOnlyInitialBalance !== undefined) {
		const drifted = await sql.query(
			`select w.id from wallets w
			   left join (select wallet_id, sum(amount) as spent from wager_transactions
			               where kind = 'BET' and status = 'PROCESSED' group by wallet_id) t
			     on t.wallet_id = w.id
			  where w.id = any($1::uuid[])
			    and w.balance <> $2::numeric - coalesce(t.spent, 0)`,
			[ids, input.betOnlyInitialBalance],
		);
		for (const row of drifted.rows) {
			violations.push(
				`wallet ${row.id} balance differs from initial - processed bets`,
			);
		}
	}
	return violations;
}

/** The outbox empties by itself once the load stops; no fixed sleep. */
export async function waitOutboxDrained(sql: Client): Promise<void> {
	await eventually(
		async () => {
			const pending = await sql.query(
				"select count(*)::int as n from outbox_messages where published_at is null",
			);
			if (pending.rows[0].n !== 0) {
				throw new Error(`${pending.rows[0].n} outbox events still unpublished`);
			}
		},
		{ timeout: 60_000, interval: 200 },
	);
}
