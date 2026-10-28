export type TransientPersistenceKind =
	| "lock_timeout"
	| "deadlock"
	| "statement_timeout";

/**
 * The database refused this attempt for a reason that may pass (55P03, 40P01, 57014).
 * Retrying the whole unit of work is the caller's call (03-messaging §3.2); nothing here retries.
 */
export class TransientPersistenceError extends Error {
	constructor(
		readonly kind: TransientPersistenceKind,
		options?: ErrorOptions,
	) {
		super(`transient persistence failure: ${kind}`, options);
		this.name = "TransientPersistenceError";
	}
}

/** The database cannot be reached at all (refused/closed connection, 57P01/57P03/08xxx, pool exhausted, network timeout). */
export class InfrastructureUnavailableError extends Error {
	constructor(options?: ErrorOptions) {
		super("database unavailable", options);
		this.name = "InfrastructureUnavailableError";
	}
}

/** A write that must hit exactly one existing row hit none. */
export class RowNotFoundError extends Error {
	constructor(what: string) {
		super(`${what} not found`);
		this.name = "RowNotFoundError";
	}
}

/** A lock or write was requested outside `TransactionManager.run`. */
export class TransactionRequiredError extends Error {
	constructor(operation: string) {
		super(`${operation} requires an active transaction`);
		this.name = "TransactionRequiredError";
	}
}
