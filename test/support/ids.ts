/** A fresh UUIDv7 per call; tests use unique ids instead of cleaning tables (no TRUNCATE). */
export function uniqueId(): string {
	return Bun.randomUUIDv7();
}
