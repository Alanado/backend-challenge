import type { Money, MoneyProps } from "../../../../shared/money";
import { InvalidIntegrationEventError } from "../errors";

/**
 * Structural view of a wager transaction. Keeps messaging independent from the
 * wagering module: `WagerTransaction` satisfies it without being imported.
 */
export interface WagerTransactionSnapshot {
	readonly id: string;
	readonly providerId: string;
	readonly externalTransactionId: string;
	readonly walletId: string;
	readonly roundId: string;
	readonly gameId: string;
	readonly kind: string;
	readonly money: Money;
	readonly referenceTransactionId: string | undefined;
	readonly failureCode: string | undefined;
	readonly processedAt: Date | undefined;
	readonly nextAttemptAt: Date | undefined;
}

export interface WagerTransactionEventData {
	transactionId: string;
	providerId: string;
	externalTransactionId: string;
	walletId: string;
	roundId: string;
	gameId: string;
	kind: string;
	money: MoneyProps;
	referenceTransactionId?: string;
}

export function transactionEventData(
	tx: WagerTransactionSnapshot,
): WagerTransactionEventData {
	return {
		transactionId: tx.id,
		providerId: tx.providerId,
		externalTransactionId: tx.externalTransactionId,
		walletId: tx.walletId,
		roundId: tx.roundId,
		gameId: tx.gameId,
		kind: tx.kind,
		money: tx.money.toJSON(),
		...(tx.referenceTransactionId === undefined
			? {}
			: { referenceTransactionId: tx.referenceTransactionId }),
	};
}

export function requireField<V>(value: V | undefined, name: string): V {
	if (value === undefined) {
		throw new InvalidIntegrationEventError(
			`transaction is missing ${name} required by the event`,
		);
	}
	return value;
}
