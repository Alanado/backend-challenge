import { z } from "zod";
import { WagerTransactionKind } from "../domain/wager-transaction-kind";

const identifier = z.string().min(1).max(128);

const moneySchema = z
	.object({
		amount: z
			.string()
			.regex(/^\d{1,17}\.\d{2}$/, {
				error:
					"must be a decimal string with up to 17 integer digits and exactly 2 decimal places",
			})
			.refine((amount) => /[1-9]/.test(amount), {
				error: "must be greater than zero",
			}),
		currency: z.string().regex(/^[A-Z]{3}$/, {
			error: "must be 3 uppercase letters",
		}),
	})
	.strict();

/**
 * The business body of a wagering transaction (04-api §3). One schema for both channels: HTTP
 * validates the request body with it and the SQS consumer (T-042a) validates the message `data`.
 * Strict: unknown fields are errors. `OPENING` is not submittable.
 */
export const submitWagerTransactionSchema = z
	.object({
		providerId: identifier,
		externalTransactionId: identifier,
		playerId: z.uuid(),
		walletId: z.uuid(),
		roundId: identifier,
		gameId: identifier,
		kind: z.enum([
			WagerTransactionKind.Bet,
			WagerTransactionKind.Win,
			WagerTransactionKind.Loss,
			WagerTransactionKind.Refund,
			WagerTransactionKind.Rollback,
		]),
		money: moneySchema,
		referenceExternalTransactionId: identifier.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		const reference = value.referenceExternalTransactionId;
		const path = ["referenceExternalTransactionId"];
		if (value.kind === WagerTransactionKind.Bet && reference !== undefined) {
			context.addIssue({
				code: "custom",
				path,
				message: "not allowed for BET",
			});
		}
		if (
			(value.kind === WagerTransactionKind.Refund ||
				value.kind === WagerTransactionKind.Rollback) &&
			reference === undefined
		) {
			context.addIssue({
				code: "custom",
				path,
				message: `required for ${value.kind}`,
			});
		}
	});

export type SubmitWagerTransactionBody = z.infer<
	typeof submitWagerTransactionSchema
>;
