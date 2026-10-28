import { z } from "zod";
import { canonicalJson, sha256Hex } from "../../../shared/hash";
import type { ValidationIssue } from "../../platform/application/validation-error";
import { RequestValidationError } from "../../platform/application/validation-error";
import { IdempotencyKey } from "../domain/idempotency-key";
import { MalformedMessageError } from "./errors";
import type { SubmitWagerTransactionCommand } from "./submit-wager-transaction";
import { submitWagerTransactionSchema } from "./submit-wager-transaction.schema";

export const WAGER_TRANSACTION_REQUESTED = "WagerTransactionRequested";

/** The envelope of the challenge statement (§10); `data` is checked by the HTTP schema below. */
const envelopeSchema = z
	.object({
		messageId: z.string().min(1).max(128),
		type: z.string(),
		occurredAt: z.iso.datetime({ offset: true }),
		data: z.record(z.string(), z.unknown()),
	})
	.strict();

export interface WagerTransactionMessage {
	messageId: string;
	/** SHA-256 of the canonical JSON of the whole body (`inbox_messages.payload_hash`). */
	bodyHash: string;
	command: SubmitWagerTransactionCommand;
}

const issuesOf = (error: z.ZodError, prefix = ""): ValidationIssue[] =>
	error.issues.map((issue) => ({
		path: `${prefix}${issue.path.join(".")}`,
		message: issue.message,
	}));

/**
 * Turns the raw body into the command of the use case. Throws `MalformedMessageError` (not JSON,
 * unknown type, OPENING) or `RequestValidationError` (shape); all of them are permanent failures.
 * The business part of `data` goes through `submitWagerTransactionSchema`, the very schema the
 * HTTP controller uses (RF-API-04); only `idempotencyKey`, which HTTP carries in a header, is
 * taken out of `data` first.
 */
export function parseWagerTransactionMessage(
	rawBody: string,
): WagerTransactionMessage {
	let json: unknown;
	try {
		json = JSON.parse(rawBody);
	} catch {
		throw new MalformedMessageError(
			"invalid_json",
			"INVALID_JSON",
			"the message body is not valid JSON",
		);
	}

	const type = (json as { type?: unknown } | null)?.type;
	if (typeof type === "string" && type !== WAGER_TRANSACTION_REQUESTED) {
		throw new MalformedMessageError(
			"unknown_type",
			"UNKNOWN_MESSAGE_TYPE",
			"the message type is not WagerTransactionRequested",
		);
	}
	const envelope = envelopeSchema.safeParse(json);
	if (!envelope.success) {
		throw new RequestValidationError(issuesOf(envelope.error));
	}

	const { idempotencyKey, ...business } = envelope.data.data;
	if (business.kind === "OPENING") {
		throw new MalformedMessageError(
			"opening_not_allowed",
			"VALIDATION_ERROR",
			"OPENING cannot be submitted",
		);
	}
	const key = idempotencyKeyOf(idempotencyKey);
	const parsed = submitWagerTransactionSchema.safeParse(business);
	if (!parsed.success) {
		throw new RequestValidationError(issuesOf(parsed.error, "data."));
	}

	return {
		messageId: envelope.data.messageId,
		bodyHash: sha256Hex(canonicalJson(json)),
		command: { ...parsed.data, idempotencyKey: key },
	};
}

function idempotencyKeyOf(value: unknown): string {
	try {
		return IdempotencyKey.from(value as string).value;
	} catch {
		throw new RequestValidationError([
			{
				path: "data.idempotencyKey",
				message: "must be 1 to 255 printable ASCII characters",
			},
		]);
	}
}
