import { toWalletView, type WalletView } from "./create-wallet";
import { WalletNotFoundError } from "./errors";
import type { WalletRepository } from "./wallet-repository";

/** Plain read: no lock, nothing decided from the balance. */
export class GetWallet {
	constructor(private readonly wallets: WalletRepository) {}

	async execute(walletId: string): Promise<WalletView> {
		const wallet = await this.wallets.findById(walletId);
		if (wallet === undefined) throw new WalletNotFoundError();
		return toWalletView(wallet);
	}
}
