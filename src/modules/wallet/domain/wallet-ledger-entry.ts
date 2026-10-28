import { InvalidLedgerEntryError } from "../../../shared/errors";
import type { Money } from "../../../shared/money";

export enum LedgerDirection {
	Debit = "DEBIT",
	Credit = "CREDIT",
}

export interface LedgerEntryState {
	id: string;
	walletId: string;
	transactionId: string;
	/** Wallet version right after this entry (ADR-0009). */
	walletVersion: number;
	direction: LedgerDirection;
	money: Money;
	balanceBefore: Money;
	balanceAfter: Money;
	createdAt: Date;
}

/** Immutable ledger line: no setters, no transitions; the instance is frozen. */
export class WalletLedgerEntry {
	readonly id: string;
	readonly walletId: string;
	readonly transactionId: string;
	readonly walletVersion: number;
	readonly direction: LedgerDirection;
	readonly money: Money;
	readonly balanceBefore: Money;
	readonly balanceAfter: Money;
	readonly createdAt: Date;

	private constructor(state: LedgerEntryState) {
		this.id = state.id;
		this.walletId = state.walletId;
		this.transactionId = state.transactionId;
		this.walletVersion = state.walletVersion;
		this.direction = state.direction;
		this.money = state.money;
		this.balanceBefore = state.balanceBefore;
		this.balanceAfter = state.balanceAfter;
		this.createdAt = state.createdAt;
		Object.freeze(this);
	}

	/** Validates the same invariants the database CHECKs enforce. */
	static create(state: LedgerEntryState): WalletLedgerEntry {
		const { money, balanceBefore, balanceAfter } = state;
		if (
			money.currency !== balanceBefore.currency ||
			money.currency !== balanceAfter.currency
		) {
			throw new InvalidLedgerEntryError("ledger entry mixes currencies");
		}
		if (!money.isPositive()) {
			throw new InvalidLedgerEntryError("ledger entry amount must be positive");
		}
		if (!Number.isInteger(state.walletVersion) || state.walletVersion < 1) {
			throw new InvalidLedgerEntryError(
				"walletVersion must be an integer >= 1",
			);
		}
		if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
			throw new InvalidLedgerEntryError("ledger balances cannot be negative");
		}
		const entry = new WalletLedgerEntry(state);
		if (!entry.isBalanced()) {
			throw new InvalidLedgerEntryError(
				"balanceBefore and money do not add up to balanceAfter",
			);
		}
		return entry;
	}

	/** Rebuilds persisted state; does not revalidate. */
	static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
		return new WalletLedgerEntry(state);
	}

	/** balanceBefore ± money === balanceAfter, according to the direction. */
	isBalanced(): boolean {
		const expected =
			this.direction === LedgerDirection.Credit
				? this.balanceBefore.add(this.money)
				: this.balanceBefore.subtract(this.money);
		return expected.equals(this.balanceAfter);
	}
}
