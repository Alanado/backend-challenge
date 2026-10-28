import { EntitySchema } from "@mikro-orm/core";

/** Persistence model of `wallets` (ADR-0004): plain data, no behaviour. Money stays a string. */
export class WalletRow {
	id!: string;
	playerId!: string;
	currency!: string;
	balance!: string;
	version!: number;
	createdAt!: Date;
	updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRow>({
	class: WalletRow,
	tableName: "wallets",
	properties: {
		id: { type: "string", columnType: "uuid", primary: true },
		playerId: { type: "string", columnType: "uuid", fieldName: "player_id" },
		currency: { type: "string", columnType: "text" },
		balance: { type: "string", columnType: "numeric(19,2)" },
		version: { type: "number", columnType: "integer" },
		createdAt: {
			type: "Date",
			columnType: "timestamptz",
			fieldName: "created_at",
		},
		updatedAt: {
			type: "Date",
			columnType: "timestamptz",
			fieldName: "updated_at",
		},
	},
});
