/** One outbox row on its way to the broker. */
export interface PublishEntry {
	/** The eventId: stable across republications, doubles as the broker deduplication id. */
	id: string;
	/** Broker ordering group (= walletId). */
	groupKey: string;
	/** The serialized integration event envelope. */
	body: string;
}

/**
 * Per-entry result. `transient` is retried with backoff forever (the event is a committed
 * financial fact); `permanent` stops the retries (`publish_failed`). Anything not recognizably
 * permanent is transient: an unknown error must never drop an event.
 */
export type PublishOutcome =
	| { id: string; status: "published" }
	| { id: string; status: "transient"; error: string }
	| { id: string; status: "permanent"; error: string };

/**
 * Port to the event broker. Returns one outcome per entry, in no particular order; an error that
 * affects the whole batch is reported as the same outcome on every entry rather than thrown.
 */
export abstract class MessagePublisher {
	abstract publishBatch(entries: PublishEntry[]): Promise<PublishOutcome[]>;
}
