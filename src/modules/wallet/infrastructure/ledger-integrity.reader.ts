import { Injectable } from "@nestjs/common";
import { Money } from "../../../shared/money";
import { MikroTransactionManager } from "../../platform/infrastructure/mikro-transaction-manager";
import {
	LedgerIntegrityRead,
	type LedgerIntegrityReport,
} from "../application/ledger-integrity";

/*
 * One statement, hence one snapshot even under READ COMMITTED (ADR-0016), and no locks: a hot
 * wallet is never held up by a reconciliation. Everything is derived from the ledger itself:
 *  - calculated = Σ CREDIT − Σ DEBIT, never the last balance_after (a lost entry would hide);
 *  - chain: the first entry starts from 0 at version 1 (opening) or 2 (wallet born at zero); each
 *    following entry starts where the previous ended, at the next version.
 */
const READ_SQL = `
with w as (
	select balance, currency, version from wallets where id = ?
), e as (
	select
		wallet_version, direction, amount, balance_before, balance_after,
		lag(balance_after) over (order by wallet_version) as prev_after,
		lag(wallet_version) over (order by wallet_version) as prev_version,
		row_number() over (order by wallet_version) as position
	from wallet_ledger_entries
	where wallet_id = ?
), agg as (
	select
		count(*)::int as checked,
		coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0.00) as calculated,
		min(wallet_version) filter (where
			(position = 1 and not (balance_before = 0 and wallet_version in (1, 2)))
			or (position > 1 and (balance_before <> prev_after or wallet_version <> prev_version + 1))
		) as first_break,
		max(wallet_version) as last_version
	from e
)
select
	w.balance::text as stored,
	w.currency as currency,
	w.version as wallet_version,
	agg.checked as checked,
	agg.calculated::text as calculated,
	agg.first_break as first_break,
	agg.last_version as last_version
from w cross join agg`;

interface ReportRow {
	stored: string;
	currency: string;
	wallet_version: number;
	checked: number;
	calculated: string;
	first_break: number | null;
	last_version: number | null;
}

/** numeric text such as "-60.00"; `Money.from` only takes non-negative input. */
function signedMoney(text: string, currency: string): Money {
	return text.startsWith("-")
		? Money.from({ amount: text.slice(1), currency }).negate()
		: Money.from({ amount: text, currency });
}

@Injectable()
export class LedgerIntegrityReader extends LedgerIntegrityRead {
	constructor(private readonly tm: MikroTransactionManager) {
		super();
	}

	async read(walletId: string): Promise<LedgerIntegrityReport | undefined> {
		const rows = await this.tm
			.current()
			.execute<ReportRow[]>(READ_SQL, [walletId, walletId]);
		const row = rows[0];
		if (row === undefined) return undefined;

		const stored = signedMoney(row.stored, row.currency);
		const calculated = signedMoney(row.calculated, row.currency);
		const difference = stored.subtract(calculated);

		// The wallet's own version must be where the ledger ends (1 when it has no entries yet).
		const expectedVersion = row.last_version ?? 1;
		const tailBreak =
			row.wallet_version === expectedVersion
				? null
				: Math.min(expectedVersion, row.wallet_version) + 1;
		const breaks = [row.first_break, tailBreak].filter(
			(version): version is number => version !== null,
		);
		const firstBreakAtVersion =
			breaks.length === 0 ? null : Math.min(...breaks);
		const continuous = firstBreakAtVersion === null;

		return {
			walletId,
			storedBalance: stored,
			calculatedBalance: calculated,
			difference,
			checkedEntries: row.checked,
			chain: { continuous, firstBreakAtVersion },
			consistent: difference.isZero() && continuous,
			walletVersion: row.wallet_version,
			lastLedgerVersion: row.last_version,
		};
	}
}
