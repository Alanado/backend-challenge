import { OutboxMessage } from "../domain/outbox-message";
import type { OutboxMessageRow } from "./outbox-message.schema";

export function outboxMessageToDomain(row: OutboxMessageRow): OutboxMessage {
	return OutboxMessage.rehydrate({
		id: row.id,
		aggregateId: row.aggregateId,
		groupKey: row.groupKey,
		eventType: row.eventType,
		payload: row.payload,
		occurredAt: row.occurredAt,
		attempts: row.attempts,
		nextAttemptAt: row.nextAttemptAt,
		publishedAt: row.publishedAt ?? undefined,
		failedAt: row.failedAt ?? undefined,
		lastError: row.lastError ?? undefined,
	});
}

export function outboxMessageToRow(message: OutboxMessage): OutboxMessageRow {
	return {
		id: message.id,
		aggregateId: message.aggregateId,
		groupKey: message.groupKey,
		eventType: message.eventType,
		payload: { ...message.payload },
		occurredAt: message.occurredAt,
		attempts: message.attempts,
		nextAttemptAt: message.nextAttemptAt,
		publishedAt: message.publishedAt ?? null,
		failedAt: message.failedAt ?? null,
		lastError: message.lastError ?? null,
	};
}
