import { type EventContext, IntegrationEvent } from "../integration-event";
import {
	requireField,
	transactionEventData,
	type WagerTransactionEventData,
	type WagerTransactionSnapshot,
} from "./wager-transaction-snapshot";

export interface WagerTransactionFailedData extends WagerTransactionEventData {
	failureCode: string;
}

export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
	readonly eventType = "WagerTransactionFailed";
	readonly version = 1;

	static from(
		tx: WagerTransactionSnapshot,
		ctx: EventContext,
	): WagerTransactionFailed {
		return new WagerTransactionFailed({
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
