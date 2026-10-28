import { Body, Controller, Headers, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { LogContext } from "../../platform/application/log-context";
import { ZodValidationPipe } from "../../platform/infrastructure/zod-validation";
import { MissingIdempotencyKeyError } from "../application/errors";
import {
	SubmitWagerTransaction,
	type WagerTransactionResult,
} from "../application/submit-wager-transaction";
import {
	type SubmitWagerTransactionBody,
	submitWagerTransactionSchema,
} from "../application/submit-wager-transaction.schema";
import { IdempotencyKey } from "../domain/idempotency-key";
import { WagerTransactionStatus } from "../domain/wager-transaction-status";

/**
 * 04-api §2: the status follows the state of the transaction. 2xx applied, 422 not applied and
 * definitive, 202 accepted with the result still pending. A replay of a PROCESSED is the only
 * 200; everything else answers what it answered the first time.
 */
export function httpStatusOf(result: WagerTransactionResult): number {
	switch (result.status) {
		case WagerTransactionStatus.Processed:
			return result.idempotentReplay ? 200 : 201;
		case WagerTransactionStatus.PendingReference:
			return 202;
		case WagerTransactionStatus.Rejected:
		case WagerTransactionStatus.Failed:
			return 422;
		case WagerTransactionStatus.Pending:
			// Never observable from outside the SQL transaction (domain contract).
			throw new Error("a PENDING transaction left the unit of work");
	}
}

function idempotencyKeyOf(header: string | undefined): string {
	if (header === undefined) throw new MissingIdempotencyKeyError();
	try {
		return IdempotencyKey.from(header).value;
	} catch {
		throw new MissingIdempotencyKeyError();
	}
}

@Controller("wagering/transactions")
export class WageringController {
	constructor(private readonly submit: SubmitWagerTransaction) {}

	@Post()
	async create(
		@Headers("idempotency-key") idempotencyKey: string | undefined,
		@Body(new ZodValidationPipe(submitWagerTransactionSchema))
		body: SubmitWagerTransactionBody,
		@Res({ passthrough: true }) response: Response,
	): Promise<WagerTransactionResult> {
		const key = idempotencyKeyOf(idempotencyKey);
		const result = await this.submit.execute(
			{ ...body, idempotencyKey: key },
			{
				channel: "http",
				// Always present behind CorrelationIdMiddleware; the fallback only keeps the type honest.
				correlationId: LogContext.current().correlationId ?? "unknown",
			},
		);
		response.status(httpStatusOf(result));
		return result;
	}
}
