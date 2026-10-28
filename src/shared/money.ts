import Big from "big.js";
import { CurrencyMismatchError, InvalidMoneyError } from "./errors";

// Isolated constructor: the global Big configuration (DP/RM) stays untouched.
const Decimal = Big();

const AMOUNT_PATTERN = /^\d{1,17}\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const SCALE = 2;

export interface MoneyProps {
	amount: string;
	currency: string;
}

/**
 * Immutable monetary value with exact decimal arithmetic (scale 2).
 *
 * `from` only accepts a validated, non-negative decimal string. Results of
 * `subtract`/`negate` may be negative in memory: that is required by
 * `isNegative()` and by the balance checks (e.g. `balance.subtract(bet)`),
 * but a negative value can never be built from external input.
 */
export class Money {
	private constructor(
		private readonly value: Big,
		public readonly currency: string,
	) {}

	static from(props: MoneyProps): Money {
		const { amount, currency } = props;
		if (typeof amount !== "string" || !AMOUNT_PATTERN.test(amount)) {
			throw new InvalidMoneyError(
				"amount must be a decimal string with exactly 2 decimal places",
			);
		}
		Money.assertCurrency(currency);
		return new Money(new Decimal(amount), currency);
	}

	static zero(currency: string): Money {
		Money.assertCurrency(currency);
		return new Money(new Decimal(0), currency);
	}

	private static assertCurrency(currency: unknown): asserts currency is string {
		if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
			throw new InvalidMoneyError("currency must be 3 uppercase letters");
		}
	}

	add(other: Money): Money {
		this.assertSameCurrency(other);
		return new Money(this.value.plus(other.value), this.currency);
	}

	subtract(other: Money): Money {
		this.assertSameCurrency(other);
		return new Money(this.value.minus(other.value), this.currency);
	}

	negate(): Money {
		// 0 - x (not x * -1) so that negating zero never yields "-0".
		return new Money(new Decimal(0).minus(this.value), this.currency);
	}

	isZero(): boolean {
		return this.value.eq(0);
	}

	isPositive(): boolean {
		return this.value.gt(0);
	}

	isNegative(): boolean {
		return this.value.lt(0);
	}

	isLessThan(other: Money): boolean {
		this.assertSameCurrency(other);
		return this.value.lt(other.value);
	}

	equals(other: Money): boolean {
		this.assertSameCurrency(other);
		return this.value.eq(other.value);
	}

	toJSON(): MoneyProps {
		return { amount: this.toString(), currency: this.currency };
	}

	/** Always fixed-point with 2 decimals (never exponential notation). */
	toString(): string {
		return this.value.toFixed(SCALE);
	}

	private assertSameCurrency(other: Money): void {
		if (this.currency !== other.currency) {
			throw new CurrencyMismatchError(this.currency, other.currency);
		}
	}
}
