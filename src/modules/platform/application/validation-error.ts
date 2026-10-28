import { DomainError } from "../../../shared/errors";

export interface ValidationIssue {
	/** Dotted path of the offending field, e.g. `initialBalance.amount`. */
	path: string;
	message: string;
}

/** The request is malformed (boundary N2): 400 `VALIDATION_ERROR`, never retried as is. */
export class RequestValidationError extends DomainError {
	readonly code = "VALIDATION_ERROR";

	constructor(readonly issues: readonly ValidationIssue[]) {
		super("request validation failed");
	}
}
