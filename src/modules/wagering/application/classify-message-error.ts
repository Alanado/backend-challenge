import { DomainError } from "../../../shared/errors";
import {
	InfrastructureUnavailableError,
	TransientPersistenceError,
} from "../../platform/application/persistence-errors";
import { RequestValidationError } from "../../platform/application/validation-error";
import { WalletNotFoundError } from "../../wallet/application/errors";
import {
	ExternalTransactionIdConflictError,
	IdempotencyKeyPayloadMismatchError,
	InboxPayloadMismatchError,
	MalformedMessageError,
} from "./errors";

/**
 * What to do about a message that failed (03-messaging §3.2). Business outcomes (PROCESSED,
 * REJECTED, PENDING_REFERENCE, replays, inbox duplicates) are results, not errors, so they never
 * come through here: they are acked.
 *  - `transient`: the message may succeed later; hide it with a backoff (consumes an attempt).
 *  - `infrastructure`: nothing can be decided now (database or broker unreachable); open the
 *    breaker and give the message back at once. Does not consume the message's patience.
 *  - `permanent`: it will never succeed; dead-letter it now. `reason` labels the metric.
 */
export type ErrorClassification =
	| { kind: "transient"; reason: string }
	| { kind: "infrastructure"; reason: string }
	| { kind: "permanent"; errorCode: string; reason: string };

const NETWORK_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ETIMEDOUT",
	"EPIPE",
	"ENOTFOUND",
	"EAI_AGAIN",
	// Bun's fetch reports connection failures under these names instead of errno codes.
	"ConnectionRefused",
	"ConnectionClosed",
	"FailedToOpenSocket",
]);

const SDK_INFRASTRUCTURE_NAMES = new Set([
	"TimeoutError",
	"RequestTimeout",
	"NetworkingError",
	"ThrottlingException",
	"RequestThrottled",
	"ServiceUnavailable",
	"InternalFailure",
	"CredentialsProviderError",
	// A queue that does not exist yet is an environment problem, never the message's fault.
	"QueueDoesNotExist",
	"AWS.SimpleQueueService.NonExistentQueue",
]);

function chainOf(error: unknown): unknown[] {
	const chain: unknown[] = [];
	let current: unknown = error;
	while (typeof current === "object" && current !== null && chain.length < 5) {
		chain.push(current);
		current = (current as { cause?: unknown }).cause;
	}
	return chain;
}

/** Network errno, SDK timeout/throttling/5xx names and a missing queue: the broker is the problem. */
function isBrokerUnavailable(error: unknown): boolean {
	return chainOf(error).some((link) => {
		const e = link as {
			name?: unknown;
			Code?: unknown;
			code?: unknown;
			$metadata?: { httpStatusCode?: unknown };
		};
		if (typeof e.code === "string" && NETWORK_CODES.has(e.code)) return true;
		if (typeof e.name === "string" && SDK_INFRASTRUCTURE_NAMES.has(e.name)) {
			return true;
		}
		if (typeof e.Code === "string" && SDK_INFRASTRUCTURE_NAMES.has(e.Code)) {
			return true;
		}
		const status = e.$metadata?.httpStatusCode;
		return typeof status === "number" && (status >= 500 || status === 429);
	});
}

export function classifyMessageError(error: unknown): ErrorClassification {
	if (error instanceof TransientPersistenceError) {
		return { kind: "transient", reason: error.kind };
	}
	if (error instanceof InfrastructureUnavailableError) {
		return { kind: "infrastructure", reason: "database_unavailable" };
	}
	if (error instanceof MalformedMessageError) {
		return {
			kind: "permanent",
			errorCode: error.code,
			reason: error.reason,
		};
	}
	if (error instanceof InboxPayloadMismatchError) {
		return {
			kind: "permanent",
			errorCode: error.code,
			reason: "inbox_payload_mismatch",
		};
	}
	if (
		error instanceof IdempotencyKeyPayloadMismatchError ||
		error instanceof ExternalTransactionIdConflictError
	) {
		return {
			kind: "permanent",
			errorCode: error.code,
			reason: "idempotency_conflict",
		};
	}
	if (error instanceof WalletNotFoundError) {
		return {
			kind: "permanent",
			errorCode: error.code,
			reason: "wallet_not_found",
		};
	}
	if (error instanceof RequestValidationError) {
		return {
			kind: "permanent",
			errorCode: error.code,
			reason: "invalid_schema",
		};
	}
	// Domain rules are deterministic: the same input fails the same way every time.
	if (error instanceof DomainError) {
		return { kind: "permanent", errorCode: error.code, reason: "domain_error" };
	}
	if (isBrokerUnavailable(error)) {
		return { kind: "infrastructure", reason: "broker_unavailable" };
	}
	// Unknown: retried with backoff, bounded by SQS_MAX_RECEIVE, never silently dropped.
	return { kind: "transient", reason: "unexpected" };
}

/** Seconds to hide a message after its `receiveCount`-th delivery failed: `min(cap, base·2^(n−1))`. */
export function visibilityBackoffSeconds(
	receiveCount: number,
	baseS: number,
	capS: number,
): number {
	const exponent = Math.max(receiveCount, 1) - 1;
	// 2^exponent overflows long before it matters; the cap decides first.
	return Math.min(capS, baseS * 2 ** Math.min(exponent, 30));
}
