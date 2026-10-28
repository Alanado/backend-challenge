import type { MoneyProps } from "../../../shared/money";
import { WalletNotFoundError } from "./errors";
import { decodeLedgerCursor, encodeLedgerCursor } from "./ledger-cursor";
import type { LedgerRepository } from "./ledger-repository";
import type { WalletRepository } from "./wallet-repository";

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;

export interface LedgerItemView {
	id: string;
	transactionId: string;
	walletVersion: number;
	direction: string;
	money: MoneyProps;
	balanceBefore: MoneyProps;
	balanceAfter: MoneyProps;
	createdAt: string;
}

export interface LedgerPageView {
	items: LedgerItemView[];
	/** null on the last page. */
	nextCursor: string | null;
}

/**
 * RF-LED-04: the ledger newest first (P-6), keyset-paged by `wallet_version`. Fetches one extra
 * row to know whether another page exists. No lock: entries are append-only, so a cursor never
 * moves under the reader (new entries only appear above it).
 */
export class ListWalletLedger {
	constructor(
		private readonly wallets: WalletRepository,
		private readonly ledger: LedgerRepository,
	) {}

	async execute(
		walletId: string,
		query: { cursor?: string | undefined; limit?: number | undefined },
	): Promise<LedgerPageView> {
		const limit = query.limit ?? DEFAULT_LEDGER_LIMIT;
		// The cursor is checked before the wallet: a malformed request is a 400 whatever the wallet.
		const before =
			query.cursor === undefined ? undefined : decodeLedgerCursor(query.cursor);
		if ((await this.wallets.findById(walletId)) === undefined) {
			throw new WalletNotFoundError();
		}

		const entries = await this.ledger.findPage(walletId, {
			before,
			limit: limit + 1,
		});
		const page = entries.slice(0, limit);
		const last = page[page.length - 1];
		return {
			items: page.map((entry) => ({
				id: entry.id,
				transactionId: entry.transactionId,
				walletVersion: entry.walletVersion,
				direction: entry.direction,
				money: entry.money.toJSON(),
				balanceBefore: entry.balanceBefore.toJSON(),
				balanceAfter: entry.balanceAfter.toJSON(),
				createdAt: entry.createdAt.toISOString(),
			})),
			nextCursor:
				entries.length > limit && last !== undefined
					? encodeLedgerCursor(last.walletVersion)
					: null,
		};
	}
}
