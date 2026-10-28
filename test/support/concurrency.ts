import type { Client } from "pg";
import { assertLedgerInvariant } from "./assertLedgerInvariant";
import type { HttpApp, Reply, TestWallet } from "./http-app";
import type { Persistence } from "./persistence";

/** Deadlocks the server has detected in the database of `sql`'s connection (PostgreSQL's own counter). */
export async function deadlocksOf(sql: Client): Promise<number> {
	const result = await sql.query(
		"select deadlocks from pg_stat_database where datname = current_database()",
	);
	return Number(result.rows[0].deadlocks);
}

/** Every wallet must still satisfy the ledger invariant once the dust settles. */
export async function assertWalletsConsistent(
	p: Persistence,
	wallets: readonly TestWallet[],
): Promise<void> {
	for (const wallet of wallets) {
		await assertLedgerInvariant(p.ledgerIntegrity, wallet.id);
	}
}

export const statusesOf = (replies: readonly Reply[]) =>
	replies.map((reply) => reply.status);

/** No reply may be a server error; a 5xx under load is a finding, never noise. */
export function expectNoServerError(replies: readonly Reply[]): void {
	const bad = replies.filter((reply) => reply.status >= 500);
	if (bad.length > 0) {
		throw new Error(
			`${bad.length} server error(s); first: ${bad[0]?.status} ${JSON.stringify(bad[0]?.body)}`,
		);
	}
}

/** `ledger` rows of a wallet, oldest first. */
export async function ledgerRows(sql: Client, walletId: string) {
	const result = await sql.query(
		"select direction, amount, wallet_version, balance_after, transaction_id from wallet_ledger_entries where wallet_id = $1 order by wallet_version",
		[walletId],
	);
	return result.rows as Array<{
		direction: string;
		amount: string;
		wallet_version: number;
		balance_after: string;
		transaction_id: string;
	}>;
}

export type { HttpApp };
