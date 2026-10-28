import { Money } from "../../../shared/money";
import { Wallet } from "../domain/wallet";
import type { WalletRow } from "./wallet.schema";

/** Rows become domain objects only through `rehydrate` (ADR-0004). */
export function walletToDomain(row: WalletRow): Wallet {
	return Wallet.rehydrate({
		id: row.id,
		playerId: row.playerId,
		balance: Money.from({ amount: row.balance, currency: row.currency }),
		version: row.version,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	});
}

export function walletToRow(wallet: Wallet): WalletRow {
	return {
		id: wallet.id,
		playerId: wallet.playerId,
		currency: wallet.currency,
		balance: wallet.balance.toString(),
		version: wallet.version,
		createdAt: wallet.createdAt,
		updatedAt: wallet.updatedAt,
	};
}
