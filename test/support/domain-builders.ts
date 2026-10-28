import { WagerTransaction } from "../../src/modules/wagering/domain/wager-transaction";
import { WagerTransactionKind } from "../../src/modules/wagering/domain/wager-transaction-kind";
import { Wallet } from "../../src/modules/wallet/domain/wallet";
import {
	LedgerDirection,
	WalletLedgerEntry,
} from "../../src/modules/wallet/domain/wallet-ledger-entry";
import { Money } from "../../src/shared/money";
import { uniqueId } from "./ids";
import type { Persistence } from "./persistence";

export const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

export function newWallet(
	amount: string,
	now = new Date(),
	playerId = uniqueId(),
): Wallet {
	return Wallet.open({
		id: uniqueId(),
		playerId,
		initialBalance: brl(amount),
		now,
	});
}

export interface TransactionOverrides {
	walletId: string;
	playerId?: string;
	kind?: WagerTransactionKind;
	amount?: string;
	providerId?: string;
	externalTransactionId?: string;
	idempotencyKey?: string;
	referenceExternalTransactionId?: string;
	now?: Date;
}

export function newTransaction(o: TransactionOverrides): WagerTransaction {
	return WagerTransaction.create({
		id: uniqueId(),
		providerId: o.providerId ?? "provider-a",
		externalTransactionId: o.externalTransactionId ?? `ext-${uniqueId()}`,
		idempotencyKey: o.idempotencyKey ?? `idem-${uniqueId()}`,
		payloadHash: "hash",
		walletId: o.walletId,
		playerId: o.playerId ?? uniqueId(),
		roundId: "round-1",
		gameId: "game-1",
		kind: o.kind ?? WagerTransactionKind.Bet,
		money: brl(o.amount ?? "10.00"),
		referenceExternalTransactionId: o.referenceExternalTransactionId,
		now: o.now ?? new Date(),
	});
}

/**
 * Opens a wallet the way the use case will: wallet at version 1, a PROCESSED OPENING transaction
 * and its OPENING ledger entry (credit, wallet_version 1), all through the repositories.
 */
export async function openWalletWithOpening(
	p: Persistence,
	amount: string,
	now = new Date(),
): Promise<Wallet> {
	const wallet = newWallet(amount, now);
	await p.tm.run(async () => {
		await p.wallets.insert(wallet);
		const opening = newTransaction({
			walletId: wallet.id,
			playerId: wallet.playerId,
			kind: WagerTransactionKind.Opening,
			amount,
			now,
		});
		await p.transactions.insertIfAbsent(opening);
		opening.markProcessed(undefined, now, wallet.balance);
		await p.transactions.update(opening, now);
		await p.ledger.append(
			WalletLedgerEntry.create({
				id: uniqueId(),
				walletId: wallet.id,
				transactionId: opening.id,
				walletVersion: 1,
				direction: LedgerDirection.Credit,
				money: wallet.balance,
				balanceBefore: Money.zero("BRL"),
				balanceAfter: wallet.balance,
				createdAt: now,
			}),
		);
	});
	return wallet;
}
