/**
 * The ONLY keys a log line may carry (ADR-0018, 04-api §8). Money, balances, payload bodies,
 * `playerId` and `roundId` are absent on purpose (P-1): adding them to a log call is a compile
 * error. The pino `redact`/scrub in the infrastructure adapter is the second, runtime layer.
 */
export interface LogFields {
	correlationId?: string;
	messageId?: string;
	/** Outbox event id (a random uuid, not business data). */
	eventId?: string;
	transactionId?: string;
	walletId?: string;
	providerId?: string;
	kind?: string;
	status?: string | number;
	failureCode?: string;
	errorCode?: string;
	durationMs?: number;
	channel?: string;
	/** Why a reconciliation diverged (a short code, never a value). */
	reason?: string;
	/** `wallet_version` where a ledger chain breaks (a position, not an amount). */
	firstBreakAtVersion?: number;
}

/** Port used by application code; the adapter (pino) lives in infrastructure. */
export abstract class AppLogger {
	abstract debug(message: string, fields?: LogFields): void;
	abstract info(message: string, fields?: LogFields): void;
	abstract warn(message: string, fields?: LogFields): void;
	abstract error(message: string, fields?: LogFields, error?: unknown): void;
}
