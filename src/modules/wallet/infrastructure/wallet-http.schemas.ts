import { z } from "zod";
import { parseWith } from "../../platform/infrastructure/zod-validation";

const moneySchema = z
	.object({
		amount: z.string().regex(/^\d{1,17}\.\d{2}$/, {
			error: "must be a decimal string with exactly 2 decimal places",
		}),
		currency: z.string().regex(/^[A-Z]{3}$/, {
			error: "must be 3 uppercase letters",
		}),
	})
	.strict();

export const createWalletSchema = z
	.object({
		playerId: z.uuid(),
		initialBalance: moneySchema,
	})
	.strict();

const walletIdSchema = z.uuid();

/** `limit` arrives as text; 1..200 (RF-LED-04). The cursor is opaque and checked by the use case. */
export const ledgerQuerySchema = z.object({
	cursor: z.string().optional(),
	limit: z
		.string()
		.regex(/^\d{1,3}$/, { error: "must be an integer from 1 to 200" })
		.transform(Number)
		.pipe(z.number().int().min(1).max(200))
		.optional(),
});

export const parseCreateWallet = (body: unknown) =>
	parseWith(createWalletSchema, body);

export const parseWalletId = (value: unknown) =>
	parseWith(walletIdSchema, value);

export const parseLedgerQuery = (query: unknown) =>
	parseWith(ledgerQuerySchema, query);
