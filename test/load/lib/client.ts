import type { TestWallet } from "../../support/http-app";
import type { Op } from "../../support/multi-instance";
import type { Outcome } from "./measurement";

/** `POST /wagering/transactions`, classified: a timeout or a dropped connection is an outcome, not a throw. */
export async function submitTimed(
	base: string,
	wallet: TestWallet,
	operation: Op,
	timeoutMs: number,
): Promise<Outcome> {
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
		return { kind: "http", status: response.status };
	} catch (error) {
		const name = error instanceof Error ? error.name : "";
		return name === "TimeoutError" || name === "AbortError"
			? { kind: "timeout" }
			: { kind: "connection" };
	}
}
