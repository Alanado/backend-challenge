/** Base of every business/domain error; `code` is stable and machine-readable. */
export abstract class DomainError extends Error {
	abstract readonly code: string;

	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

export class InvalidMoneyError extends DomainError {
	readonly code = "INVALID_MONEY";
}

export class CurrencyMismatchError extends DomainError {
	readonly code = "CURRENCY_MISMATCH";

	constructor(expected: string, received: string) {
		super(`currency mismatch: expected ${expected}, received ${received}`);
	}
}
