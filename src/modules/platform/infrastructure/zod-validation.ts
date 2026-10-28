import { type ArgumentMetadata, type PipeTransform } from "@nestjs/common";
import type { z } from "zod";
import { RequestValidationError } from "../application/validation-error";

/** The one place a Zod failure becomes the boundary error (N2): 400 `VALIDATION_ERROR`. */
export function parseWith<T>(schema: z.ZodType<T>, input: unknown): T {
	const result = schema.safeParse(input);
	if (result.success) return result.data;
	throw new RequestValidationError(
		result.error.issues.map((issue) => ({
			path: issue.path.join("."),
			message: issue.message,
		})),
	);
}

/** `@Body(new ZodValidationPipe(schema))`: the same validation as `parseWith`, as a Nest pipe. */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
	constructor(private readonly schema: z.ZodType<T>) {}

	transform(value: unknown, _metadata: ArgumentMetadata): T {
		return parseWith(this.schema, value);
	}
}
