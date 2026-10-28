import type { Clock } from "../../../shared/clock";
import type { IdGenerator } from "../../../shared/ids";
import { Money, type MoneyProps } from "../../../shared/money";
import type { OutboxRepository } from "../../messaging/application/outbox-repository";
import { WalletBalanceChanged } from "../../messaging/domain/events/wallet-balance-changed";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import { LogContext } from "../../platform/application/log-context";
import type { TransactionManager } from "../../platform/application/transaction-manager";
import type { WagerTransactionRepository } from "../../wagering/application/wager-transaction-repository";
import { payloadHash } from "../../wagering/domain/payload-hash";
import { WagerTransaction } from "../../wagering/domain/wager-transaction";
import { WagerTransactionKind } from "../../wagering/domain/wager-transaction-kind";
import { Wallet } from "../domain/wallet";
import {
	LedgerDirection,
	WalletLedgerEntry,
} from "../domain/wallet-ledger-entry";
import type { LedgerRepository } from "./ledger-repository";
import type { WalletRepository } from "./wallet-repository";

/** Provider of the internal OPENING transaction (P-5). */
export const SYSTEM_PROVIDER_ID = "system";
// `round_id` and `game_id` are NOT NULL and an OPENING has neither: fixed, documented values (W5 report).
const OPENING_ROUND_ID = "opening";
const OPENING_GAME_ID = "system";

export interface CreateWalletCommand {
	playerId: string;
	initialBalance: MoneyProps;
	/** Of the request; goes into the event envelope. */
	correlationId: string;
}

export interface WalletView {
	id: string;
	playerId: string;
	balance: MoneyProps;
	version: number;
}

export function toWalletView(wallet: Wallet): WalletView {
	return {
		id: wallet.id,
		playerId: wallet.playerId,
		balance: wallet.balance.toJSON(),
		version: wallet.version,
	};
}

/**
 * RF-WAL-01/02. One SQL transaction: wallet (version 1) and, when the opening balance is above
 * zero, the OPENING transaction, its CREDIT ledger entry and the `WalletBalanceChanged` event.
 * A duplicate (player, currency) is refused by the UNIQUE inside `wallets.insert`, which aborts
 * the whole unit of work.
 *
 * Lock order (ADR-0007): the wallet row is inserted by this very transaction, so no other session
 * can see it, let alone lock it, before the `wager_transactions` insert; no decision here reads a
 * balance that someone else could change.
 */
export class CreateWallet {
	constructor(
		private readonly tm: TransactionManager,
		private readonly wallets: WalletRepository,
		private readonly transactions: WagerTransactionRepository,
		private readonly ledger: LedgerRepository,
		private readonly outbox: OutboxRepository,
		private readonly clock: Clock,
		private readonly ids: IdGenerator,
	) {}

	execute(command: CreateWalletCommand): Promise<WalletView> {
		const initial = Money.from(command.initialBalance);
		const now = this.clock.now();
		const wallet = Wallet.open({
			id: this.ids.next(),
			playerId: command.playerId,
			initialBalance: initial,
			now,
		});
		LogContext.setWalletId(wallet.id);

		return this.tm.run(async () => {
			await this.wallets.insert(wallet);
			// Zero is valid (P-13 only concerns transactions): nothing to record besides the wallet.
			if (initial.isPositive()) {
				await this.recordOpening(wallet, initial, command.correlationId, now);
			}
			return toWalletView(wallet);
		});
	}

	private async recordOpening(
		wallet: Wallet,
		amount: Money,
		correlationId: string,
		now: Date,
	): Promise<void> {
		const externalTransactionId = `opening:${wallet.id}`;
		const opening = WagerTransaction.create({
			id: this.ids.next(),
			providerId: SYSTEM_PROVIDER_ID,
			externalTransactionId,
			idempotencyKey: externalTransactionId,
			payloadHash: payloadHash({
				providerId: SYSTEM_PROVIDER_ID,
				externalTransactionId,
				playerId: wallet.playerId,
				walletId: wallet.id,
				roundId: OPENING_ROUND_ID,
				gameId: OPENING_GAME_ID,
				kind: WagerTransactionKind.Opening,
				money: amount,
			}),
			walletId: wallet.id,
			playerId: wallet.playerId,
			roundId: OPENING_ROUND_ID,
			gameId: OPENING_GAME_ID,
			kind: WagerTransactionKind.Opening,
			money: amount,
			now,
		});
		opening.markProcessed(undefined, now, wallet.balance);
		if (!(await this.transactions.insertIfAbsent(opening))) {
			// The id embeds the new wallet's own id: a clash means a bug, not a duplicate request.
			throw new Error("OPENING transaction already exists for a new wallet");
		}

		const entry = WalletLedgerEntry.create({
			id: this.ids.next(),
			walletId: wallet.id,
			transactionId: opening.id,
			walletVersion: 1,
			direction: LedgerDirection.Credit,
			money: amount,
			balanceBefore: Money.zero(amount.currency),
			balanceAfter: wallet.balance,
			createdAt: now,
		});
		await this.ledger.append(entry);

		const event = WalletBalanceChanged.from(entry, {
			eventId: this.ids.next(),
			correlationId,
			occurredAt: now,
		});
		await this.outbox.enqueue(OutboxMessage.enqueue(event, wallet.id));
	}
}
