import { type EventContext, IntegrationEvent } from "../integration-event";
import {
	requireField,
	transactionEventData,
	type WagerTransactionEventData,
	type WagerTransactionSnapshot,
} from "./wager-transaction-snapshot";

export interface WagerTransactionProcessedData
	extends WagerTransactionEventData {
	processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
	readonly eventType = "WagerTransactionProcessed";
	readonly version = 1;

	static from(
		tx: WagerTransactionSnapshot,
		ctx: EventContext,
	): WagerTransactionProcessed {
		return new WagerTransactionProcessed({
			eventId: ctx.eventId,
			aggregateId: tx.id,
			correlationId: ctx.correlationId,
			causationId: tx.id,
			occurredAt: ctx.occurredAt,
			data: {
				...transactionEventData(tx),
				processedAt: requireField(tx.processedAt, "processedAt").toISOString(),
			},
		});
	}
}
