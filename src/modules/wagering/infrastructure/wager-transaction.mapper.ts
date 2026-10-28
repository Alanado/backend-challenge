import { Money } from "../../../shared/money";
import type { FailureCode } from "../domain/failure-code";
import { WagerTransaction } from "../domain/wager-transaction";
import type { WagerTransactionKind } from "../domain/wager-transaction-kind";
import type { WagerTransactionStatus } from "../domain/wager-transaction-status";
import type { WagerTransactionRow } from "./wager-transaction.schema";

const orUndefined = <T>(value: T | null): T | undefined => value ?? undefined;

/** Always through `rehydrate`: terminal states come back without any transition being replayed. */
export function wagerTransactionToDomain(
	row: WagerTransactionRow,
): WagerTransaction {
	const money = (amount: string) =>
		Money.from({ amount, currency: row.currency });
	return WagerTransaction.rehydrate({
		id: row.id,
		providerId: row.providerId,
		externalTransactionId: row.externalTransactionId,
		idempotencyKey: row.idempotencyKey,
		payloadHash: row.payloadHash,
		walletId: row.walletId,
		playerId: row.playerId,
		roundId: row.roundId,
		gameId: row.gameId,
		// kind, status and failure_code are constrained by CHECKs to the enum values.
		kind: row.kind as WagerTransactionKind,
		money: money(row.amount),
		referenceExternalTransactionId: orUndefined(
			row.referenceExternalTransactionId,
		),
		createdAt: row.createdAt,
		status: row.status as WagerTransactionStatus,
		referenceTransactionId: orUndefined(row.referenceTransactionId),
		failureCode: orUndefined(row.failureCode) as FailureCode | undefined,
		processedAt: orUndefined(row.processedAt),
		observedBalance:
			row.observedBalance === null ? undefined : money(row.observedBalance),
		referenceAttempts: row.referenceAttempts,
		nextAttemptAt: orUndefined(row.nextAttemptAt),
	});
}

/** `updatedAt` is persistence-only (the domain does not carry it), so the caller supplies it. */
export function wagerTransactionToRow(
	transaction: WagerTransaction,
	updatedAt: Date,
): WagerTransactionRow {
	return {
		id: transaction.id,
		providerId: transaction.providerId,
		externalTransactionId: transaction.externalTransactionId,
		idempotencyKey: transaction.idempotencyKey,
		payloadHash: transaction.payloadHash,
		walletId: transaction.walletId,
		playerId: transaction.playerId,
		roundId: transaction.roundId,
		gameId: transaction.gameId,
		kind: transaction.kind,
		amount: transaction.money.toString(),
		currency: transaction.money.currency,
		status: transaction.status,
		referenceExternalTransactionId:
			transaction.referenceExternalTransactionId ?? null,
		referenceTransactionId: transaction.referenceTransactionId ?? null,
		failureCode: transaction.failureCode ?? null,
		observedBalance: transaction.observedBalance?.toString() ?? null,
		referenceAttempts: transaction.referenceAttempts,
		nextAttemptAt: transaction.nextAttemptAt ?? null,
		createdAt: transaction.createdAt,
		processedAt: transaction.processedAt ?? null,
		updatedAt,
	};
}
