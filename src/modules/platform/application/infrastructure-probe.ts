/** Port: "does the database answer?" (`SELECT 1`). The circuit breaker's half-open probe. */
export abstract class InfrastructureProbe {
	/** Resolves when the database answered; rejects otherwise. */
	abstract ping(): Promise<void>;
}
