import type { Wallet } from "../domain/wallet";

/** `updateBalance` matched no row at the expected version: a bug, never retried (ADR-0006). */
export class VersionAssertionError extends Error {
	constructor(walletId: string, expectedVersion: number) {
		super(
			`wallet ${walletId} was not at version ${expectedVersion} when updating its balance`,
		);
		this.name = "VersionAssertionError";
	}
}

export abstract class WalletRepository {
	/** `SELECT … FOR UPDATE`: requires an active transaction. Every balance decision reads through this. */
	abstract findByIdForUpdate(id: string): Promise<Wallet | undefined>;
	abstract findById(id: string): Promise<Wallet | undefined>;
	abstract findByPlayerAndCurrency(
		playerId: string,
		currency: string,
	): Promise<Wallet | undefined>;
	abstract insert(wallet: Wallet): Promise<void>;
	/**
	 * Persists balance, version and updatedAt of `wallet` where the stored row is still at
	 * `expectedVersion`; throws `VersionAssertionError` when no row matches.
	 */
	abstract updateBalance(
		wallet: Wallet,
		expectedVersion: number,
	): Promise<void>;
}
