/** Fields the caller supplies; the event derives aggregate and causation ids. */
export interface EventContext {
	eventId: string;
	correlationId: string;
	occurredAt: Date;
}

export interface IntegrationEventProps<T> {
	eventId: string;
	aggregateId: string;
	correlationId: string;
	causationId?: string | undefined;
	occurredAt: Date;
	data: T;
}

export interface IntegrationEventJson<T> {
	eventId: string;
	eventType: string;
	aggregateId: string;
	correlationId: string;
	causationId?: string;
	occurredAt: string;
	version: number;
	data: T;
}

/**
 * Envelope of every integration event. `data` carries only JSON-stable values
 * (money as `MoneyProps` strings, dates as ISO strings), never domain objects.
 */
export abstract class IntegrationEvent<T> {
	abstract readonly eventType: string;
	abstract readonly version: number;

	readonly eventId: string;
	readonly aggregateId: string;
	readonly correlationId: string;
	readonly causationId: string | undefined;
	readonly occurredAt: Date;
	readonly data: Readonly<T>;

	protected constructor(props: IntegrationEventProps<T>) {
		this.eventId = props.eventId;
		this.aggregateId = props.aggregateId;
		this.correlationId = props.correlationId;
		this.causationId = props.causationId;
		this.occurredAt = props.occurredAt;
		this.data = Object.freeze({ ...props.data });
	}

	/** Envelope serialized into the outbox payload. */
	toJSON(): IntegrationEventJson<T> {
		return {
			eventId: this.eventId,
			eventType: this.eventType,
			aggregateId: this.aggregateId,
			correlationId: this.correlationId,
			...(this.causationId === undefined
				? {}
				: { causationId: this.causationId }),
			occurredAt: this.occurredAt.toISOString(),
			version: this.version,
			data: this.data,
		};
	}
}
