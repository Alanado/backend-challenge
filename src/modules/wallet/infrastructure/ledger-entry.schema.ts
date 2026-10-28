import { EntitySchema } from "@mikro-orm/core";

/** Persistence model of `wallet_ledger_entries`; the table is append-only (triggers, ADR-0009). */
export class LedgerEntryRow {
	id!: string;
	walletId!: string;
	transactionId!: string;
	walletVersion!: number;
	direction!: string;
	amount!: string;
	currency!: string;
	balanceBefore!: string;
	balanceAfter!: string;
	createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRow>({
	class: LedgerEntryRow,
	tableName: "wallet_ledger_entries",
	properties: {
		id: { type: "string", columnType: "uuid", primary: true },
		walletId: { type: "string", columnType: "uuid", fieldName: "wallet_id" },
		transactionId: {
			type: "string",
			columnType: "uuid",
			fieldName: "transaction_id",
		},
		walletVersion: {
			type: "number",
			columnType: "integer",
			fieldName: "wallet_version",
		},
		direction: { type: "string", columnType: "text" },
		amount: { type: "string", columnType: "numeric(19,2)" },
		currency: { type: "string", columnType: "text" },
		balanceBefore: {
			type: "string",
			columnType: "numeric(19,2)",
			fieldName: "balance_before",
		},
		balanceAfter: {
			type: "string",
			columnType: "numeric(19,2)",
			fieldName: "balance_after",
		},
		createdAt: {
			type: "Date",
			columnType: "timestamptz",
			fieldName: "created_at",
		},
	},
});
