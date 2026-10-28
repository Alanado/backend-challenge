import { DomainError } from "../../../shared/errors";

/** Same idempotency key, different business payload (ADR-0008): 409 `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`. */
export class IdempotencyKeyPayloadMismatchError extends DomainError {
	readonly code = "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH";

	constructor() {
		super("the idempotency key was already used with a different payload");
	}
}

/** The external transaction id already belongs to another idempotency key: 409 `EXTERNAL_TRANSACTION_ID_CONFLICT`. */
export class ExternalTransactionIdConflictError extends DomainError {
	readonly code = "EXTERNAL_TRANSACTION_ID_CONFLICT";

	constructor() {
		super("the external transaction id was already used with another key");
	}
}

/** `Idempotency-Key` header absent or not 1..255 printable ASCII (P-8): 400 `MISSING_IDEMPOTENCY_KEY`. */
export class MissingIdempotencyKeyError extends DomainError {
	readonly code = "MISSING_IDEMPOTENCY_KEY";

	constructor() {
		super(
			"the Idempotency-Key header is required: 1 to 255 printable ASCII characters",
		);
	}
}

/** No transaction under that id (or provider + external id): 404 `TRANSACTION_NOT_FOUND`. */
export class TransactionNotFoundError extends DomainError {
	readonly code = "TRANSACTION_NOT_FOUND";

	constructor() {
		super("transaction not found");
	}
}
