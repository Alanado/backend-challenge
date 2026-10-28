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

export class InvalidLedgerEntryError extends DomainError {
	readonly code = "INVALID_LEDGER_ENTRY";
}

export class InvalidTransactionStateError extends DomainError {
	readonly code = "INVALID_TRANSACTION_STATE";

	constructor(from: string, operation: string) {
		super(`cannot apply ${operation} to a transaction in state ${from}`);
	}
}

export class InvalidReferenceRequirementError extends DomainError {
	readonly code = "INVALID_REFERENCE_REQUIREMENT";
}

export class LedgerDirectionUnavailableError extends DomainError {
	readonly code = "LEDGER_DIRECTION_UNAVAILABLE";
}

export class InvalidIdempotencyKeyError extends DomainError {
	readonly code = "INVALID_IDEMPOTENCY_KEY";
}
