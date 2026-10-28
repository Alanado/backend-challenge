import { DomainError } from "../../../shared/errors";

export class InvalidInboxStateError extends DomainError {
	readonly code = "INVALID_INBOX_STATE";
}

export class InvalidOutboxStateError extends DomainError {
	readonly code = "INVALID_OUTBOX_STATE";
}

export class InvalidIntegrationEventError extends DomainError {
	readonly code = "INVALID_INTEGRATION_EVENT";
}
