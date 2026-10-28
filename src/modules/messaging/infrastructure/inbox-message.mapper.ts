import { InboxMessage } from "../domain/inbox-message";
import type { InboxMessageRow } from "./inbox-message.schema";

export function inboxMessageToDomain(row: InboxMessageRow): InboxMessage {
	return InboxMessage.rehydrate({
		messageId: row.messageId,
		consumerName: row.consumerName,
		payloadHash: row.payloadHash,
		receivedAt: row.receivedAt,
		processedAt: row.processedAt ?? undefined,
	});
}

export function inboxMessageToRow(message: InboxMessage): InboxMessageRow {
	return {
		consumerName: message.consumerName,
		messageId: message.messageId,
		payloadHash: message.payloadHash,
		receivedAt: message.receivedAt,
		processedAt: message.processedAt ?? null,
	};
}
