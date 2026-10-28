import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";

export abstract class LedgerRepository {
	abstract append(entry: WalletLedgerEntry): Promise<void>;
	/** All entries of the wallet, oldest version first. */
	abstract findByWallet(walletId: string): Promise<WalletLedgerEntry[]>;
	/**
	 * Keyset page, newest first: entries with `wallet_version < before` (all when omitted), at most
	 * `limit` of them. Plain read, no lock (RF-LED-04).
	 */
	abstract findPage(
		walletId: string,
		page: { before?: number | undefined; limit: number },
	): Promise<WalletLedgerEntry[]>;
}
