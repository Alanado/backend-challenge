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
