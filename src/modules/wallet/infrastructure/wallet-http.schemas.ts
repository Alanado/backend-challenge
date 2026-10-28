import { z } from "zod";
import { RequestValidationError } from "../../platform/application/validation-error";

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

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
	const result = schema.safeParse(input);
	if (result.success) return result.data;
	throw new RequestValidationError(
		result.error.issues.map((issue) => ({
			path: issue.path.join("."),
			message: issue.message,
		})),
	);
}

export const parseCreateWallet = (body: unknown) =>
	parse(createWalletSchema, body);

export const parseWalletId = (value: unknown) => parse(walletIdSchema, value);
