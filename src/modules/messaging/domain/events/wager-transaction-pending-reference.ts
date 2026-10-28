import { type EventContext, IntegrationEvent } from "../integration-event";
import {
	requireField,
	transactionEventData,
	type WagerTransactionEventData,
	type WagerTransactionSnapshot,
} from "./wager-transaction-snapshot";

export interface WagerTransactionPendingReferenceData
	extends WagerTransactionEventData {
	nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
	readonly eventType = "WagerTransactionPendingReference";
	readonly version = 1;

	static from(
		tx: WagerTransactionSnapshot,
		ctx: EventContext,
	): WagerTransactionPendingReference {
		return new WagerTransactionPendingReference({
			eventId: ctx.eventId,
			aggregateId: tx.id,
			correlationId: ctx.correlationId,
			causationId: tx.id,
			occurredAt: ctx.occurredAt,
			data: {
				...transactionEventData(tx),
				nextAttemptAt: requireField(
					tx.nextAttemptAt,
					"nextAttemptAt",
				).toISOString(),
			},
		});
	}
}
