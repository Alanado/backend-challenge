import { Money } from "../../../shared/money";
import {
	LedgerDirection,
	WalletLedgerEntry,
} from "../domain/wallet-ledger-entry";
import type { LedgerEntryRow } from "./ledger-entry.schema";

export function ledgerEntryToDomain(row: LedgerEntryRow): WalletLedgerEntry {
	const money = (amount: string) =>
		Money.from({ amount, currency: row.currency });
	return WalletLedgerEntry.rehydrate({
		id: row.id,
		walletId: row.walletId,
		transactionId: row.transactionId,
		walletVersion: row.walletVersion,
		// The column is constrained to the two enum values (CHECK).
		direction: row.direction as LedgerDirection,
		money: money(row.amount),
		balanceBefore: money(row.balanceBefore),
		balanceAfter: money(row.balanceAfter),
		createdAt: row.createdAt,
	});
}

export function ledgerEntryToRow(entry: WalletLedgerEntry): LedgerEntryRow {
	return {
		id: entry.id,
		walletId: entry.walletId,
		transactionId: entry.transactionId,
		walletVersion: entry.walletVersion,
		direction: entry.direction,
		amount: entry.money.toString(),
		currency: entry.money.currency,
		balanceBefore: entry.balanceBefore.toString(),
		balanceAfter: entry.balanceAfter.toString(),
		createdAt: entry.createdAt,
	};
}
