import { describe, expect, test } from "bun:test";
import { classifyMessageError } from "../../../src/modules/wagering/application/classify-message-error";
import { submitWagerTransactionSchema } from "../../../src/modules/wagering/application/submit-wager-transaction.schema";
import { parseWagerTransactionMessage } from "../../../src/modules/wagering/application/wager-transaction-message";
import { WagerTransactionKind } from "../../../src/modules/wagering/domain/wager-transaction-kind";

const data = (overrides: Record<string, unknown> = {}) => ({
	providerId: "provider-a",
	externalTransactionId: "ext-1",
	idempotencyKey: "provider-a:ext-1",
	playerId: "0197f9e4-6b6a-7c1f-8d2e-3a4b5c6d7e8f",
	walletId: "0197f9e4-6b6a-7c1f-8d2e-3a4b5c6d7e90",
	roundId: "round-1",
	gameId: "game-1",
	kind: "BET",
	money: { amount: "25.00", currency: "BRL" },
	...overrides,
});

const message = (
	overrides: Record<string, unknown> = {},
	dataOverrides: Record<string, unknown> = {},
) =>
	JSON.stringify({
		messageId: "msg-1",
		type: "WagerTransactionRequested",
		occurredAt: "2026-10-28T12:00:00.000Z",
		data: data(dataOverrides),
		...overrides,
	});

describe("TST-U-11 parsing a WagerTransactionRequested", () => {
	test("TST-U-11 a valid message becomes the use case command, with the key taken from data", () => {
		const parsed = parseWagerTransactionMessage(message());
		expect(parsed.messageId).toBe("msg-1");
		expect(parsed.command).toEqual({
			providerId: "provider-a",
			externalTransactionId: "ext-1",
			idempotencyKey: "provider-a:ext-1",
			playerId: "0197f9e4-6b6a-7c1f-8d2e-3a4b5c6d7e8f",
			walletId: "0197f9e4-6b6a-7c1f-8d2e-3a4b5c6d7e90",
			roundId: "round-1",
			gameId: "game-1",
			kind: WagerTransactionKind.Bet,
			money: { amount: "25.00", currency: "BRL" },
		});
	});

	test("TST-U-11 the body hash covers the whole body and ignores key order and whitespace", () => {
		const a = parseWagerTransactionMessage(message());
		const reordered = JSON.stringify({
			data: data(),
			occurredAt: "2026-10-28T12:00:00.000Z",
			type: "WagerTransactionRequested",
			messageId: "msg-1",
		});
		expect(parseWagerTransactionMessage(`  ${reordered}`).bodyHash).toBe(
			a.bodyHash,
		);
		expect(a.bodyHash).toMatch(/^[0-9a-f]{64}$/);
		// another occurredAt is another body, although the business payload is the same
		expect(
			parseWagerTransactionMessage(
				message({ occurredAt: "2026-10-28T12:00:01.000Z" }),
			).bodyHash,
		).not.toBe(a.bodyHash);
	});

	test("TST-U-11 a REFUND carries its reference", () => {
		const parsed = parseWagerTransactionMessage(
			message({}, { kind: "REFUND", referenceExternalTransactionId: "ext-0" }),
		);
		expect(parsed.command.referenceExternalTransactionId).toBe("ext-0");
	});

	test.each([
		["not JSON", "{oops", "INVALID_JSON", "invalid_json"],
		["a JSON scalar", "42", "VALIDATION_ERROR", "invalid_schema"],
		[
			"an unknown type",
			message({ type: "SomethingElse" }),
			"UNKNOWN_MESSAGE_TYPE",
			"unknown_type",
		],
		[
			"kind OPENING",
			message({}, { kind: "OPENING" }),
			"VALIDATION_ERROR",
			"opening_not_allowed",
		],
		[
			"a missing messageId",
			message({ messageId: undefined }),
			"VALIDATION_ERROR",
			"invalid_schema",
		],
		[
			"an extra envelope field",
			message({ extra: 1 }),
			"VALIDATION_ERROR",
			"invalid_schema",
		],
		[
			"a malformed occurredAt",
			message({ occurredAt: "yesterday" }),
			"VALIDATION_ERROR",
			"invalid_schema",
		],
		[
			"a missing idempotencyKey",
			message({}, { idempotencyKey: undefined }),
			"VALIDATION_ERROR",
			"invalid_schema",
		],
		[
			"a non-ASCII idempotencyKey",
			message({}, { idempotencyKey: "chave-é" }),
			"VALIDATION_ERROR",
			"invalid_schema",
		],
		[
			"a numeric amount",
			message({}, { money: { amount: 25, currency: "BRL" } }),
			"VALIDATION_ERROR",
			"invalid_schema",
		],
		[
			"an unknown business field",
			message({}, { bonus: "1.00" }),
			"VALIDATION_ERROR",
			"invalid_schema",
		],
		[
			"a BET with a reference",
			message({}, { referenceExternalTransactionId: "ext-0" }),
			"VALIDATION_ERROR",
			"invalid_schema",
		],
	])(
		"TST-U-11 %s is a permanent failure",
		(_label, body, errorCode, reason) => {
			let thrown: unknown;
			try {
				parseWagerTransactionMessage(body);
			} catch (error) {
				thrown = error;
			}
			expect(classifyMessageError(thrown)).toEqual({
				kind: "permanent",
				errorCode,
				reason,
			});
		},
	);

	test("TST-U-11 the business fields are validated by the very schema the HTTP controller uses", async () => {
		// Imported, not copied: a new rule in the shared schema reaches SQS with no further change.
		const source = await Bun.file(
			`${import.meta.dir}/../../../src/modules/wagering/application/wager-transaction-message.ts`,
		).text();
		expect(source).toContain(
			'import { submitWagerTransactionSchema } from "./submit-wager-transaction.schema"',
		);
		expect(submitWagerTransactionSchema.safeParse(data().money).success).toBe(
			false,
		);
	});
});
