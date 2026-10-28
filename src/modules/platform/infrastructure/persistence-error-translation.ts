import {
	InfrastructureUnavailableError,
	TransientPersistenceError,
} from "../application/persistence-errors";

const NETWORK_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ETIMEDOUT",
	"EPIPE",
	"ENOTFOUND",
	"EAI_AGAIN",
]);

// pg / pg-pool messages that carry no code: dropped connection, pool exhausted, connect timeout.
const UNAVAILABLE_MESSAGE =
	/connection terminated|timeout exceeded when trying to connect|client has encountered a connection error|pool is probably full|timeout acquiring a connection|connection (?:refused|closed)/i;

function causes(error: unknown): unknown[] {
	const chain: unknown[] = [];
	let current: unknown = error;
	while (current !== undefined && current !== null && chain.length < 5) {
		chain.push(current);
		current = (current as { cause?: unknown }).cause;
	}
	return chain;
}

/**
 * Boundary N14: turns driver failures into application types. The SQLSTATE sits in `err.code`
 * (adr/0002-spike.md); node network errnos are checked along the `cause` chain. Anything not
 * recognised is returned as is.
 */
export function translatePersistenceError(error: unknown): unknown {
	if (
		error instanceof TransientPersistenceError ||
		error instanceof InfrastructureUnavailableError
	) {
		return error;
	}
	for (const link of causes(error)) {
		const code = (link as { code?: unknown }).code;
		if (typeof code === "string") {
			if (code === "55P03")
				return new TransientPersistenceError("lock_timeout", { cause: error });
			if (code === "40P01")
				return new TransientPersistenceError("deadlock", { cause: error });
			if (code === "57014")
				return new TransientPersistenceError("statement_timeout", {
					cause: error,
				});
			if (
				code === "57P01" ||
				code === "57P03" ||
				code.startsWith("08") ||
				NETWORK_CODES.has(code)
			) {
				return new InfrastructureUnavailableError({ cause: error });
			}
		}
		const message = (link as { message?: unknown }).message;
		if (typeof message === "string" && UNAVAILABLE_MESSAGE.test(message)) {
			return new InfrastructureUnavailableError({ cause: error });
		}
	}
	return error;
}
