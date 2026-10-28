import type { Money, MoneyProps } from "../../../../shared/money";
import { type EventContext, IntegrationEvent } from "../integration-event";

/** Structural view of a ledger entry (satisfied by `WalletLedgerEntry`). */
export interface LedgerEntrySnapshot {
	readonly walletId: string;
	readonly transactionId: string;
	readonly direction: string;
	readonly money: Money;
	readonly balanceBefore: Money;
	readonly balanceAfter: Money;
	readonly walletVersion: number;
}

export interface WalletBalanceChangedData {
	walletId: string;
	transactionId: string;
	direction: string;
	money: MoneyProps;
	balanceBefore: MoneyProps;
	balanceAfter: MoneyProps;
	walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
	readonly eventType = "WalletBalanceChanged";
	readonly version = 1;

	static from(
		entry: LedgerEntrySnapshot,
		ctx: EventContext,
	): WalletBalanceChanged {
		return new WalletBalanceChanged({
			eventId: ctx.eventId,
			aggregateId: entry.walletId,
			correlationId: ctx.correlationId,
			causationId: entry.transactionId,
			occurredAt: ctx.occurredAt,
			data: {
				walletId: entry.walletId,
				transactionId: entry.transactionId,
				direction: entry.direction,
				money: entry.money.toJSON(),
				balanceBefore: entry.balanceBefore.toJSON(),
				balanceAfter: entry.balanceAfter.toJSON(),
				walletVersion: entry.walletVersion,
			},
		});
	}
}
