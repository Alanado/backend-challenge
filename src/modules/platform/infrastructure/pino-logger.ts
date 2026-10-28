import pino, { type DestinationStream, type Logger } from "pino";
import { LogContext } from "../application/log-context";
import type { AppLogger, LogFields } from "../application/log-fields";

/**
 * Keys that must never reach a log line (P-1, RF-OBS-02), compared case-insensitively at any
 * depth. `LogFields` keeps them out at compile time; this is the runtime net for third-party
 * and `unknown` data (framework logs, error objects, anything cast past the type).
 */
const FORBIDDEN_KEYS = new Set(
	[
		"amount",
		"balance",
		"balanceBefore",
		"balanceAfter",
		"initialBalance",
		"observedBalance",
		"money",
		"payload",
		"data",
		"body",
		"playerId",
		"player_id",
		"roundId",
		"round_id",
	].map((key) => key.toLowerCase()),
);

const TRUNCATED = "[Truncated]";
const MAX_DEPTH = 12;

/** Top-level and one-level-down paths for pino's own `redact` (fast path; the scrub covers depth). */
const REDACT_PATHS = [
	"amount",
	"balance",
	"money",
	"payload",
	"data",
	"body",
	"playerId",
	"roundId",
	"*.amount",
	"*.balance",
	"*.money",
	"*.payload",
	"*.data",
	"*.body",
	"*.playerId",
	"*.roundId",
];

// Driver messages quote row values: MikroORM appends "\n - detail: Key (...)=(...)", PostgreSQL
// itself says "DETAIL: ...". Cut those off, then mask any uuid or 2-decimal amount left in the text.
const DETAIL_TAIL = /(?:\n\s*-\s*detail:|\bDETAIL:)[\s\S]*/i;
const UUID_TEXT =
	/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const AMOUNT_TEXT = /\b\d+\.\d{2}\b/g;

function sanitizeText(text: string): string {
	return text
		.replace(DETAIL_TAIL, "")
		.replace(UUID_TEXT, "[id]")
		.replace(AMOUNT_TEXT, "[amount]");
}

/**
 * Deep copy without forbidden keys. Errors are reduced to type, message and stack: driver errors
 * carry `detail`/`parameters` with row values. (pino runs `formatters.log` before serializers,
 * so the error handling has to live here.)
 */
function scrub(value: unknown, depth: number): unknown {
	if (value instanceof Error) {
		return {
			type: value.name,
			message: sanitizeText(value.message),
			stack: value.stack === undefined ? undefined : sanitizeText(value.stack),
		};
	}
	if (value === null || typeof value !== "object") return value;
	if (depth >= MAX_DEPTH) return TRUNCATED;
	if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (!FORBIDDEN_KEYS.has(key.toLowerCase())) {
			out[key] = scrub(item, depth + 1);
		}
	}
	return out;
}

export interface PinoLoggerOptions {
	level: string;
	/** Defaults to stdout. Tests pass a capturing stream. */
	destination?: DestinationStream;
}

export function createPinoLogger({
	level,
	destination,
}: PinoLoggerOptions): Logger {
	return pino(
		{
			level,
			redact: { paths: REDACT_PATHS, remove: true },
			// `scrub` already reduced errors; the default `err` serializer would re-wrap the copy.
			serializers: { err: (value: unknown) => value },
			// Request/message context (correlationId, walletId, ...) rides on every line.
			mixin: () => ({ ...LogContext.current() }),
			formatters: {
				// Deep scrub of the merged object (mixin included).
				log: (object) => scrub(object, 0) as Record<string, unknown>,
			},
		},
		destination,
	);
}

/** `AppLogger` over pino; `LogFields` is the only shape application code can pass. */
export class PinoAppLogger implements AppLogger {
	constructor(private readonly logger: Logger) {}

	debug(message: string, fields?: LogFields): void {
		this.logger.debug(fields ?? {}, message);
	}
	info(message: string, fields?: LogFields): void {
		this.logger.info(fields ?? {}, message);
	}
	warn(message: string, fields?: LogFields): void {
		this.logger.warn(fields ?? {}, message);
	}
	error(message: string, fields?: LogFields, error?: unknown): void {
		this.logger.error(
			{ ...fields, ...(error === undefined ? {} : { err: error }) },
			message,
		);
	}
}
