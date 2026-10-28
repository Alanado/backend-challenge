import {
	CurrencyMismatchError,
	DomainError,
	InvalidMoneyError,
} from "../../../shared/errors";
import type { Money } from "../../../shared/money";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export class InsufficientFundsError extends DomainError {
	readonly code = "INSUFFICIENT_FUNDS";
}

export interface WalletState {
	id: string;
	playerId: string;
	balance: Money;
	version: number;
	createdAt: Date;
	updatedAt: Date;
}

/**
 * Aggregate root. `version` starts at 1 and only increases when the balance
 * changes. The OPENING ledger entry (version 1) is built by the use case.
 */
export class Wallet {
	private constructor(
		public readonly id: string,
		public readonly playerId: string,
		public readonly createdAt: Date,
		private _balance: Money,
		private _version: number,
		private _updatedAt: Date,
	) {}

	static open(props: {
		id: string;
		playerId: string;
		initialBalance: Money;
		now: Date;
	}): Wallet {
		if (props.initialBalance.isNegative()) {
			throw new InvalidMoneyError("initial balance cannot be negative");
		}
		return new Wallet(
			props.id,
			props.playerId,
			props.now,
			props.initialBalance,
			1,
			props.now,
		);
	}

	/** Rebuilds persisted state; does not revalidate. */
	static rehydrate(state: WalletState): Wallet {
		return new Wallet(
			state.id,
			state.playerId,
			state.createdAt,
			state.balance,
			state.version,
			state.updatedAt,
		);
	}

	get currency(): string {
		return this._balance.currency;
	}

	get balance(): Money {
		return this._balance;
	}

	get version(): number {
		return this._version;
	}

	get updatedAt(): Date {
		return this._updatedAt;
	}

	/** Throws `InsufficientFundsError` without changing anything. */
	debit(
		money: Money,
		transactionId: string,
		now: Date,
		entryId: string,
	): WalletLedgerEntry {
		return this.apply(
			LedgerDirection.Debit,
			money,
			transactionId,
			now,
			entryId,
		);
	}

	credit(
		money: Money,
		transactionId: string,
		now: Date,
		entryId: string,
	): WalletLedgerEntry {
		return this.apply(
			LedgerDirection.Credit,
			money,
			transactionId,
			now,
			entryId,
		);
	}

	private apply(
		direction: LedgerDirection,
		money: Money,
		transactionId: string,
		now: Date,
		entryId: string,
	): WalletLedgerEntry {
		if (money.currency !== this.currency) {
			throw new CurrencyMismatchError(this.currency, money.currency);
		}
		if (!money.isPositive()) {
			throw new InvalidMoneyError("amount must be positive");
		}
		const balanceAfter =
			direction === LedgerDirection.Credit
				? this._balance.add(money)
				: this._balance.subtract(money);
		if (balanceAfter.isNegative()) {
			throw new InsufficientFundsError("insufficient funds");
		}
		// Build the entry first: if it throws, the wallet stays untouched.
		const entry = WalletLedgerEntry.create({
			id: entryId,
			walletId: this.id,
			transactionId,
			walletVersion: this._version + 1,
			direction,
			money,
			balanceBefore: this._balance,
			balanceAfter,
			createdAt: now,
		});
		this._balance = balanceAfter;
		this._version = entry.walletVersion;
		this._updatedAt = now;
		return entry;
	}
}
