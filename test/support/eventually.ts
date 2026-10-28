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
