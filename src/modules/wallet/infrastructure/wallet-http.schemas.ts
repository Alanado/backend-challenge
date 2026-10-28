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

export const parseCreateWallet = (body: unknown) =>
	parseWith(createWalletSchema, body);

export const parseWalletId = (value: unknown) =>
	parseWith(walletIdSchema, value);
