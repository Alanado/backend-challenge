import { EntitySchema } from "@mikro-orm/core";

export class InboxMessageRow {
	consumerName!: string;
	messageId!: string;
	payloadHash!: string;
	receivedAt!: Date;
	processedAt!: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRow>({
	class: InboxMessageRow,
	tableName: "inbox_messages",
	properties: {
		consumerName: {
			type: "string",
			columnType: "text",
			fieldName: "consumer_name",
			primary: true,
		},
		messageId: {
			type: "string",
			columnType: "text",
			fieldName: "message_id",
			primary: true,
		},
		payloadHash: {
			type: "string",
			columnType: "text",
			fieldName: "payload_hash",
		},
		receivedAt: {
			type: "Date",
			columnType: "timestamptz",
			fieldName: "received_at",
		},
		processedAt: {
			type: "Date",
			columnType: "timestamptz",
			fieldName: "processed_at",
			nullable: true,
		},
	},
});
