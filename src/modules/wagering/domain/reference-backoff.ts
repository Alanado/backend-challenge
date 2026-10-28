/** Backoff of the PENDING_REFERENCE retries (ADR-0013); mirrors `AppConfig.pendingRef`. */
export interface ReferenceBackoffConfig {
	/** Attempts before the transaction is rejected with REFERENCE_NOT_FOUND (the caller enforces it). */
	maxAttempts: number;
	baseMs: number;
	factor: number;
	capMs: number;
}

/**
 * Delay in milliseconds before retry number `attempt` (0-based): exponential
 * `min(cap, base * factor^attempt)` with equal jitter, `d/2 + random * d/2`, so the delay always
 * falls in `[d/2, d)` and never collapses to zero. `random` returns a value in `[0, 1)` and is
 * injectable so tests are deterministic.
 */
export function referenceBackoff(
	attempt: number,
	config: ReferenceBackoffConfig,
	random: () => number = Math.random,
): number {
	if (!Number.isInteger(attempt) || attempt < 0) {
		throw new RangeError("attempt must be a non-negative integer");
	}
	// Math.min keeps a huge exponent (Infinity) under the cap.
	const ceiling = Math.min(
		config.baseMs * config.factor ** attempt,
		config.capMs,
	);
	return ceiling / 2 + random() * (ceiling / 2);
}
