import { type EventContext, IntegrationEvent } from "../integration-event";
import {
	requireField,
	transactionEventData,
	type WagerTransactionEventData,
	type WagerTransactionSnapshot,
} from "./wager-transaction-snapshot";

export interface WagerTransactionRejectedData
	extends WagerTransactionEventData {
	failureCode: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
	readonly eventType = "WagerTransactionRejected";
	readonly version = 1;

	static from(
		tx: WagerTransactionSnapshot,
		ctx: EventContext,
	): WagerTransactionRejected {
		return new WagerTransactionRejected({
			eventId: ctx.eventId,
			aggregateId: tx.id,
			correlationId: ctx.correlationId,
			causationId: tx.id,
			occurredAt: ctx.occurredAt,
			data: {
				...transactionEventData(tx),
				failureCode: requireField(tx.failureCode, "failureCode"),
			},
		});
	}
}
