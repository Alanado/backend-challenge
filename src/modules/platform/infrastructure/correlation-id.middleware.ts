import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { Uuidv7Generator } from "../../../shared/ids";
import { LogContext } from "../application/log-context";
import { AppLogger } from "../application/log-fields";

export const CORRELATION_HEADER = "X-Correlation-Id";

// What we accept back from a client: printable ASCII, bounded. Anything else is replaced, never echoed.
const ACCEPTED = /^[\x21-\x7E]{1,128}$/;

/**
 * Boundary N15 (HTTP): reads `X-Correlation-Id` or mints a UUIDv7, puts it in the log context for
 * the whole request and returns it on the response. Logs one line per request without path,
 * query or body (RF-OBS-02).
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
	private readonly ids = new Uuidv7Generator();

	constructor(private readonly logger: AppLogger) {}

	use(request: Request, response: Response, next: NextFunction): void {
		const supplied = request.header(CORRELATION_HEADER);
		const correlationId =
			supplied !== undefined && ACCEPTED.test(supplied)
				? supplied
				: this.ids.next();
		response.setHeader(CORRELATION_HEADER, correlationId);
		const startedAt = performance.now();

		LogContext.run({ correlationId }, () => {
			// The live store: ids set later in the request (walletId, ...) show up in the access line.
			const store = LogContext.current();
			response.once("finish", () => {
				LogContext.run(store, () =>
					this.logger.info("request completed", {
						channel: "http",
						status: response.statusCode,
						durationMs: Math.round(performance.now() - startedAt),
					}),
				);
			});
			next();
		});
	}
}
