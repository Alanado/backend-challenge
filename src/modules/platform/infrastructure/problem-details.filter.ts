import {
	type ArgumentsHost,
	Catch,
	type ExceptionFilter,
	HttpException,
	Injectable,
} from "@nestjs/common";
import type { Request, Response } from "express";
import {
	ExternalTransactionIdConflictError,
	IdempotencyKeyPayloadMismatchError,
	MissingIdempotencyKeyError,
	TransactionNotFoundError,
} from "../../wagering/application/errors";
import {
	InvalidCursorError,
	WalletAlreadyExistsError,
	WalletNotFoundError,
} from "../../wallet/application/errors";
import { LogContext } from "../application/log-context";
import { AppLogger } from "../application/log-fields";
import {
	InfrastructureUnavailableError,
	TransientPersistenceError,
} from "../application/persistence-errors";
import { RequestValidationError } from "../application/validation-error";
import {
	CORRELATION_HEADER,
	resolveCorrelationId,
} from "./correlation-id.middleware";

interface Problem {
	status: number;
	errorCode: string;
	title: string;
	detail: string;
	retryable: boolean;
	retryAfterSeconds?: number;
}

const INTERNAL: Problem = {
	status: 500,
	errorCode: "INTERNAL_ERROR",
	title: "Internal error",
	// Never the cause: stack, SQL and driver messages stay in the logs.
	detail: "The request could not be processed. Report the correlation id.",
	retryable: false,
};

function describeValidation(error: RequestValidationError): string {
	const issues = error.issues.map((i) =>
		i.path === "" ? i.message : `${i.path}: ${i.message}`,
	);
	return issues.length === 0 ? "Invalid request" : issues.join("; ");
}

/** Maps what the application throws to the problem catalog of 04-api §4.2 (04-api §4.2). */
function problemFor(exception: unknown): Problem | undefined {
	if (exception instanceof RequestValidationError) {
		return {
			status: 400,
			errorCode: "VALIDATION_ERROR",
			title: "Invalid request",
			detail: describeValidation(exception),
			retryable: false,
		};
	}
	if (exception instanceof MissingIdempotencyKeyError) {
		return {
			status: 400,
			errorCode: "MISSING_IDEMPOTENCY_KEY",
			title: "Idempotency key missing or invalid",
			detail: exception.message,
			retryable: false,
		};
	}
	if (exception instanceof InvalidCursorError) {
		return {
			status: 400,
			errorCode: "INVALID_CURSOR",
			title: "Invalid cursor",
			detail: exception.message,
			retryable: false,
		};
	}
	if (exception instanceof IdempotencyKeyPayloadMismatchError) {
		return {
			status: 409,
			errorCode: "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH",
			title: "Idempotency key reused with a different payload",
			detail: exception.message,
			retryable: false,
		};
	}
	if (exception instanceof ExternalTransactionIdConflictError) {
		return {
			status: 409,
			errorCode: "EXTERNAL_TRANSACTION_ID_CONFLICT",
			title: "External transaction id already used with another key",
			detail: exception.message,
			retryable: false,
		};
	}
	if (exception instanceof TransactionNotFoundError) {
		return {
			status: 404,
			errorCode: "TRANSACTION_NOT_FOUND",
			title: "Transaction not found",
			detail: exception.message,
			retryable: false,
		};
	}
	if (exception instanceof WalletAlreadyExistsError) {
		return {
			status: 409,
			errorCode: "WALLET_ALREADY_EXISTS",
			title: "Wallet already exists",
			detail: exception.message,
			retryable: false,
		};
	}
	if (exception instanceof WalletNotFoundError) {
		return {
			status: 404,
			errorCode: "WALLET_NOT_FOUND",
			title: "Wallet not found",
			detail: exception.message,
			retryable: false,
		};
	}
	if (
		exception instanceof TransientPersistenceError ||
		exception instanceof InfrastructureUnavailableError
	) {
		return {
			status: 503,
			errorCode: "SERVICE_UNAVAILABLE",
			title: "Service temporarily unavailable",
			detail: "A dependency is temporarily unavailable. Retry the request.",
			retryable: true,
			retryAfterSeconds: 1,
		};
	}
	return undefined;
}

/**
 * Boundary N3: every error leaves the API as `application/problem+json` (RFC 9457) with
 * `errorCode`, `correlationId` and `retryable`. Nest's own HttpExceptions keep their default body,
 * except a 400 (malformed JSON from the body parser), which is a `VALIDATION_ERROR`.
 */
@Catch()
@Injectable()
export class ProblemDetailsFilter implements ExceptionFilter {
	constructor(private readonly logger: AppLogger) {}

	catch(exception: unknown, host: ArgumentsHost): void {
		const http = host.switchToHttp();
		const response = http.getResponse<Response>();

		if (exception instanceof HttpException && exception.getStatus() !== 400) {
			response.status(exception.getStatus()).json(exception.getResponse());
			return;
		}

		const problem = this.classify(exception);
		const correlationId = this.correlationIdOf(
			http.getRequest<Request>(),
			response,
		);

		if (problem.status >= 500) {
			this.logger.error(
				"request failed",
				{ errorCode: problem.errorCode, status: problem.status },
				exception,
			);
		}
		if (problem.retryAfterSeconds !== undefined) {
			response.setHeader("Retry-After", String(problem.retryAfterSeconds));
		}
		response.status(problem.status).type("application/problem+json").json({
			type: "about:blank",
			title: problem.title,
			status: problem.status,
			errorCode: problem.errorCode,
			detail: problem.detail,
			correlationId,
			retryable: problem.retryable,
		});
	}

	/**
	 * Normally set by the middleware. A request that fails in the body parser never reaches it, so
	 * the header is completed here: every response carries the id (N15).
	 */
	private correlationIdOf(request: Request, response: Response): string {
		const existing = response.getHeader(CORRELATION_HEADER);
		if (existing !== undefined) return existing.toString();
		const correlationId =
			LogContext.current().correlationId ?? resolveCorrelationId(request);
		response.setHeader(CORRELATION_HEADER, correlationId);
		return correlationId;
	}

	private classify(exception: unknown): Problem {
		if (exception instanceof HttpException) {
			// Only 400 reaches here: unparsable body.
			return {
				status: 400,
				errorCode: "VALIDATION_ERROR",
				title: "Invalid request",
				detail: "The request body could not be parsed.",
				retryable: false,
			};
		}
		return problemFor(exception) ?? INTERNAL;
	}
}
