import { EntitySchema } from "@mikro-orm/core";

/** Persistence model of `wager_transactions` (ADR-0004). Nullable columns are `null`, never `undefined`. */
export class WagerTransactionRow {
	id!: string;
	providerId!: string;
	externalTransactionId!: string;
	idempotencyKey!: string;
	payloadHash!: string;
	walletId!: string;
	playerId!: string;
	roundId!: string;
	gameId!: string;
	kind!: string;
	amount!: string;
	currency!: string;
	status!: string;
	referenceExternalTransactionId!: string | null;
	referenceTransactionId!: string | null;
	failureCode!: string | null;
	observedBalance!: string | null;
	referenceAttempts!: number;
	nextAttemptAt!: Date | null;
	createdAt!: Date;
	processedAt!: Date | null;
	updatedAt!: Date;
}

const timestamptz = (fieldName: string, nullable = false) => ({
	type: "Date" as const,
	columnType: "timestamptz",
	fieldName,
	nullable,
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRow>({
	class: WagerTransactionRow,
	tableName: "wager_transactions",
	properties: {
		id: { type: "string", columnType: "uuid", primary: true },
		providerId: {
			type: "string",
			columnType: "text",
			fieldName: "provider_id",
		},
		externalTransactionId: {
			type: "string",
			columnType: "text",
			fieldName: "external_transaction_id",
		},
		idempotencyKey: {
			type: "string",
			columnType: "text",
			fieldName: "idempotency_key",
		},
		payloadHash: {
			type: "string",
			columnType: "text",
			fieldName: "payload_hash",
		},
		walletId: { type: "string", columnType: "uuid", fieldName: "wallet_id" },
		playerId: { type: "string", columnType: "uuid", fieldName: "player_id" },
		roundId: { type: "string", columnType: "text", fieldName: "round_id" },
		gameId: { type: "string", columnType: "text", fieldName: "game_id" },
		kind: { type: "string", columnType: "text" },
		amount: { type: "string", columnType: "numeric(19,2)" },
		currency: { type: "string", columnType: "text" },
		status: { type: "string", columnType: "text" },
		referenceExternalTransactionId: {
			type: "string",
			columnType: "text",
			fieldName: "reference_external_transaction_id",
			nullable: true,
		},
		referenceTransactionId: {
			type: "string",
			columnType: "uuid",
			fieldName: "reference_transaction_id",
			nullable: true,
		},
		failureCode: {
			type: "string",
			columnType: "text",
			fieldName: "failure_code",
			nullable: true,
		},
		observedBalance: {
			type: "string",
			columnType: "numeric(19,2)",
			fieldName: "observed_balance",
			nullable: true,
		},
		referenceAttempts: {
			type: "number",
			columnType: "integer",
			fieldName: "reference_attempts",
		},
		nextAttemptAt: timestamptz("next_attempt_at", true),
		createdAt: timestamptz("created_at"),
		processedAt: timestamptz("processed_at", true),
		updatedAt: timestamptz("updated_at"),
	},
});
