import { EntitySchema } from "@mikro-orm/core";

export class OutboxMessageRow {
	id!: string;
	aggregateId!: string;
	groupKey!: string;
	eventType!: string;
	payload!: Record<string, unknown>;
	occurredAt!: Date;
	attempts!: number;
	nextAttemptAt!: Date;
	publishedAt!: Date | null;
	failedAt!: Date | null;
	lastError!: string | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRow>({
	class: OutboxMessageRow,
	tableName: "outbox_messages",
	properties: {
		id: { type: "string", columnType: "uuid", primary: true },
		aggregateId: {
			type: "string",
			columnType: "text",
			fieldName: "aggregate_id",
		},
		groupKey: { type: "string", columnType: "text", fieldName: "group_key" },
		eventType: { type: "string", columnType: "text", fieldName: "event_type" },
		payload: { type: "json", columnType: "jsonb" },
		occurredAt: {
			type: "Date",
			columnType: "timestamptz",
			fieldName: "occurred_at",
		},
		attempts: { type: "number", columnType: "integer" },
		nextAttemptAt: {
			type: "Date",
			columnType: "timestamptz",
			fieldName: "next_attempt_at",
		},
		publishedAt: {
			type: "Date",
			columnType: "timestamptz",
			fieldName: "published_at",
			nullable: true,
		},
		failedAt: {
			type: "Date",
			columnType: "timestamptz",
			fieldName: "failed_at",
			nullable: true,
		},
		lastError: {
			type: "string",
			columnType: "text",
			fieldName: "last_error",
			nullable: true,
		},
	},
});
