import { describe, expect, test } from "bun:test";
import {
	InfrastructureUnavailableError,
	TransientPersistenceError,
} from "../../../src/modules/platform/application/persistence-errors";
import { RequestValidationError } from "../../../src/modules/platform/application/validation-error";
import { translatePersistenceError } from "../../../src/modules/platform/infrastructure/persistence-error-translation";
import {
	classifyMessageError,
	visibilityBackoffSeconds,
} from "../../../src/modules/wagering/application/classify-message-error";
import {
	ExternalTransactionIdConflictError,
	IdempotencyKeyPayloadMismatchError,
	InboxPayloadMismatchError,
	MalformedMessageError,
} from "../../../src/modules/wagering/application/errors";
import { WalletNotFoundError } from "../../../src/modules/wallet/application/errors";
import { DomainError } from "../../../src/shared/errors";

const pg = (code: string) =>
	Object.assign(new Error("driver failure"), { code });
const sdk = (fields: Record<string, unknown>) =>
	Object.assign(new Error("sdk failure"), fields);

describe("TST-U-11 error classification: Postgres codes (through the persistence boundary)", () => {
	test.each([
		["55P03", "transient"],
		["40P01", "transient"],
		["57014", "transient"],
		["57P01", "infrastructure"],
		["57P03", "infrastructure"],
		["08000", "infrastructure"],
		["08006", "infrastructure"],
		["08001", "infrastructure"],
		["ECONNREFUSED", "infrastructure"],
		["ECONNRESET", "infrastructure"],
		["ETIMEDOUT", "infrastructure"],
		// not recognised by the boundary: unexpected, so retried a bounded number of times
		["23505", "transient"],
		["XX000", "transient"],
	] as const)("TST-U-11 %s is %s", (code, expected) => {
		const classified = classifyMessageError(
			translatePersistenceError(pg(code)),
		);
		expect(classified.kind).toBe(expected);
	});

	test("TST-U-11 lock_timeout and deadlock are NOT infrastructure (they must not open the breaker)", () => {
		for (const kind of [
			"lock_timeout",
			"deadlock",
			"statement_timeout",
		] as const) {
			expect(classifyMessageError(new TransientPersistenceError(kind))).toEqual(
				{
					kind: "transient",
					reason: kind,
				},
			);
		}
	});

	test("TST-U-11 an unavailable database is infrastructure", () => {
		expect(
			classifyMessageError(new InfrastructureUnavailableError()).kind,
		).toBe("infrastructure");
	});
});

describe("TST-U-11 error classification: application errors", () => {
	test.each([
		[new WalletNotFoundError(), "WALLET_NOT_FOUND", "wallet_not_found"],
		[
			new InboxPayloadMismatchError(),
			"INBOX_PAYLOAD_MISMATCH",
			"inbox_payload_mismatch",
		],
		[
			new IdempotencyKeyPayloadMismatchError(),
			"IDEMPOTENCY_KEY_PAYLOAD_MISMATCH",
			"idempotency_conflict",
		],
		[
			new ExternalTransactionIdConflictError(),
			"EXTERNAL_TRANSACTION_ID_CONFLICT",
			"idempotency_conflict",
		],
		[
			new RequestValidationError([{ path: "kind", message: "nope" }]),
			"VALIDATION_ERROR",
			"invalid_schema",
		],
		[
			new MalformedMessageError("invalid_json", "INVALID_JSON", "x"),
			"INVALID_JSON",
			"invalid_json",
		],
		[
			new MalformedMessageError("unknown_type", "UNKNOWN_MESSAGE_TYPE", "x"),
			"UNKNOWN_MESSAGE_TYPE",
			"unknown_type",
		],
		[
			new MalformedMessageError("opening_not_allowed", "VALIDATION_ERROR", "x"),
			"VALIDATION_ERROR",
			"opening_not_allowed",
		],
	] as const)(
		"TST-U-11 %p is permanent (%s, %s)",
		(error, errorCode, reason) => {
			expect(classifyMessageError(error)).toEqual({
				kind: "permanent",
				errorCode,
				reason,
			});
		},
	);

	test("TST-U-11 any other domain error is permanent: the same input would fail the same way", () => {
		class OddRule extends DomainError {
			readonly code = "ODD_RULE";
		}
		expect(classifyMessageError(new OddRule("x"))).toEqual({
			kind: "permanent",
			errorCode: "ODD_RULE",
			reason: "domain_error",
		});
	});

	test.each([
		new Error("boom"),
		"a string",
		undefined,
		null,
		new TypeError("x"),
	])(
		"TST-U-11 an unexpected error (%p) is transient, so attempts stay bounded",
		(error) => {
			expect(classifyMessageError(error)).toEqual({
				kind: "transient",
				reason: "unexpected",
			});
		},
	);
});

describe("TST-U-11 error classification: SQS SDK errors", () => {
	test.each([
		["QueueDoesNotExist", { name: "QueueDoesNotExist" }],
		[
			"AWS.SimpleQueueService.NonExistentQueue",
			{ name: "Error", Code: "AWS.SimpleQueueService.NonExistentQueue" },
		],
		["TimeoutError", { name: "TimeoutError" }],
		["ECONNREFUSED", { code: "ECONNREFUSED" }],
		["Bun ConnectionRefused", { code: "ConnectionRefused" }],
		["Bun ConnectionClosed", { code: "ConnectionClosed" }],
		["throttling", { name: "ThrottlingException" }],
		[
			"HTTP 503",
			{ name: "ServiceUnavailable", $metadata: { httpStatusCode: 503 } },
		],
		["HTTP 500", { name: "InternalError", $metadata: { httpStatusCode: 500 } }],
		["network error in the cause chain", { cause: { code: "ECONNRESET" } }],
	])("TST-U-11 SDK error %s is infrastructure", (_label, fields) => {
		expect(classifyMessageError(sdk(fields)).kind).toBe("infrastructure");
	});

	test("TST-U-11 a client-side SDK error alone is not permanent (the spike: $fault=client is not enough)", () => {
		const error = sdk({
			name: "InvalidParameterValue",
			$fault: "client",
			$metadata: { httpStatusCode: 400 },
		});
		expect(classifyMessageError(error).kind).toBe("transient");
	});
});

describe("TST-U-11 visibility backoff: min(cap, base·2^(receiveCount−1))", () => {
	test.each([
		[1, 2],
		[2, 4],
		[3, 8],
		[4, 16],
		[5, 30],
		[6, 30],
		[8, 30],
		[40, 30],
	])(
		"TST-U-11 receiveCount %d waits %d s (base 2, cap 30)",
		(count, expected) => {
			expect(visibilityBackoffSeconds(count, 2, 30)).toBe(expected);
		},
	);

	test("TST-U-11 a custom base and cap (the test configuration)", () => {
		expect(visibilityBackoffSeconds(1, 1, 3)).toBe(1);
		expect(visibilityBackoffSeconds(2, 1, 3)).toBe(2);
		expect(visibilityBackoffSeconds(3, 1, 3)).toBe(3);
	});

	test("TST-U-11 a receiveCount below 1 is treated as the first delivery", () => {
		expect(visibilityBackoffSeconds(0, 2, 30)).toBe(2);
	});
});
