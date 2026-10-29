import type { TestWallet } from "../../support/http-app";
import type { Op } from "../../support/multi-instance";
import type { Outcome } from "./measurement";

/**
 * `POST /wagering/transactions`, classified: a timeout or a dropped connection is an outcome, not a
 * throw. A connection reset is retried once with the same Idempotency-Key (the key makes the POST
 * safe to repeat); the outcome then carries `recovered` so the report counts it. A reset on the
 * retry is an error.
 */
export async function submitTimed(
	base: string,
	wallet: TestWallet,
	operation: Op,
	timeoutMs: number,
): Promise<Outcome> {
	const first = await attemptOnce(base, wallet, operation, timeoutMs);
	if (first.kind !== "connection" || !first.reset) return first.outcome;
	const second = await attemptOnce(base, wallet, operation, timeoutMs);
	return second.outcome.kind === "http"
		? { ...second.outcome, recovered: true }
		: second.outcome;
}

async function attemptOnce(
	base: string,
	wallet: TestWallet,
	operation: Op,
	timeoutMs: number,
): Promise<{ kind: "ok" | "connection"; reset: boolean; outcome: Outcome }> {
	try {
		const response = await fetch(`${base}/wagering/transactions`, {
			method: "POST",
			signal: AbortSignal.timeout(timeoutMs),
			headers: {
				"Content-Type": "application/json",
				"Idempotency-Key": operation.key,
			},
			body: JSON.stringify({
				providerId: "provider-a",
				externalTransactionId: operation.externalTransactionId,
				playerId: wallet.playerId,
				walletId: wallet.id,
				roundId: "round-1",
				gameId: "game-1",
				kind: operation.kind,
				money: { amount: operation.amount, currency: "BRL" },
				...(operation.reference === undefined
					? {}
					: { referenceExternalTransactionId: operation.reference }),
			}),
		});
		await response.arrayBuffer();
		return {
			kind: "ok",
			reset: false,
			outcome: { kind: "http", status: response.status },
		};
	} catch (error) {
		const name = error instanceof Error ? error.name : "";
		noteFailure(error);
		if (name === "TimeoutError" || name === "AbortError") {
			return { kind: "connection", reset: false, outcome: { kind: "timeout" } };
		}
		const reset = (error as { code?: string }).code === "ECONNRESET";
		return { kind: "connection", reset, outcome: { kind: "connection" } };
	}
}

const seen = new Set<string>();

/** A failure that is not a timeout is printed once per distinct cause, so a run explains its own errors. */
function noteFailure(error: unknown): void {
	const code = (error as { code?: string }).code ?? "";
	const label =
		`${error instanceof Error ? error.name : "unknown"} ${code} ${error instanceof Error ? error.message : ""}`.trim();
	if (seen.has(label) || seen.size >= 5) return;
	seen.add(label);
	console.error(`request failure: ${label}`);
}
