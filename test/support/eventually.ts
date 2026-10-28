export interface EventuallyOptions {
	/** Total budget in ms (default 5000). */
	timeout?: number;
	/** Pause between attempts in ms (default 25). */
	interval?: number;
}

/**
 * Polls `condition` until it neither throws nor returns `false`, and returns its value.
 * An attempt that already succeeds costs no wait. On timeout the error carries the last failure.
 */
export async function eventually<T>(
	condition: () => T | Promise<T>,
	{ timeout = 5000, interval = 25 }: EventuallyOptions = {},
): Promise<Exclude<T, false>> {
	const deadline = performance.now() + timeout;
	let lastError: unknown;
	for (;;) {
		try {
			const value = await condition();
			if (value !== false) return value as Exclude<T, false>;
			lastError = new Error("condition returned false");
		} catch (err) {
			lastError = err;
		}
		if (performance.now() + interval > deadline) break;
		await new Promise((resolve) => setTimeout(resolve, interval));
	}
	const detail =
		lastError instanceof Error ? lastError.message : String(lastError);
	throw new Error(
		`eventually timed out after ${timeout}ms; last error: ${detail}`,
		{
			cause: lastError,
		},
	);
}

/**
 * Negative assertion: `check` must hold at every sample for `durationMs`. The window is fixed on
 * purpose (it observes that something does NOT happen); `check` throws to fail, and the error
 * names the elapsed time. Use `eventually` for everything that is supposed to happen.
 */
export async function holdsFor(
	durationMs: number,
	check: () => void | Promise<void>,
	intervalMs = 100,
): Promise<void> {
	const start = performance.now();
	do {
		try {
			await check();
		} catch (err) {
			const elapsed = Math.round(performance.now() - start);
			const detail = err instanceof Error ? err.message : String(err);
			throw new Error(`stopped holding after ${elapsed}ms: ${detail}`, {
				cause: err,
			});
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	} while (performance.now() - start < durationMs);
}
