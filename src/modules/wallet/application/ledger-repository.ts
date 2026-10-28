import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";

export abstract class LedgerRepository {
	abstract append(entry: WalletLedgerEntry): Promise<void>;
	/** All entries of the wallet, oldest version first (cursor pagination is T-034). */
	abstract findByWallet(walletId: string): Promise<WalletLedgerEntry[]>;
}
