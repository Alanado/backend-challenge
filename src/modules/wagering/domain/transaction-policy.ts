import { UnexpectedReferenceStateError } from "../../../shared/errors";
import type { Wallet } from "../../wallet/domain/wallet";
import { LedgerDirection } from "../../wallet/domain/wallet-ledger-entry";
import { FailureCode } from "./failure-code";
import type { WagerTransaction } from "./wager-transaction";
import { WagerTransactionKind as Kind } from "./wager-transaction-kind";
import { WagerTransactionStatus as Status } from "./wager-transaction-status";

/** The referenced transaction as loaded by the caller, plus the reversal fact. */
export interface ReferenceFacts {
	transaction: WagerTransaction;
	/** The reference already has a PROCESSED reversal (REFUND/ROLLBACK). */
	alreadyReversed: boolean;
}

export interface PolicyInput {
	/** Read with FOR UPDATE by the caller. */
	wallet: Wallet;
	transaction: WagerTransaction;
	/** `undefined` = no transaction with the referenced external id exists yet. */
	reference: ReferenceFacts | undefined;
}

/** `direction` is `undefined` when the transaction is applied without moving balance (LOSS). */
export type TransactionDecision =
	| { type: "APPLY"; direction: LedgerDirection | undefined }
	| { type: "REJECT"; failureCode: FailureCode }
	| { type: "PENDING_REFERENCE" };

const ALLOWED_REFERENCE_KINDS: Record<Kind, readonly Kind[]> = {
	[Kind.Refund]: [Kind.Bet],
	[Kind.Rollback]: [Kind.Bet, Kind.Win, Kind.Refund],
	[Kind.Win]: [Kind.Bet],
	[Kind.Loss]: [Kind.Bet],
	[Kind.Bet]: [],
	[Kind.Opening]: [],
};

export function allowedReferenceKinds(kind: Kind): Kind[] {
	return [...ALLOWED_REFERENCE_KINDS[kind]];
}

const reject = (failureCode: FailureCode): TransactionDecision => ({
	type: "REJECT",
	failureCode,
});

/**
 * Pure decision in the exact order of 02-design §5; the first deviation wins:
 *  1. wallet player, wallet currency
 *  2. reference: absent -> pending; kind; wallet/player/currency/round;
 *     reversal amount; reference pending -> pending; reference rejected/failed;
 *     already reversed
 *  3. balance: BET -> INSUFFICIENT_FUNDS; debit reversal -> REVERSAL_WOULD_OVERDRAW
 */
export function decideTransaction(input: PolicyInput): TransactionDecision {
	const { wallet, transaction, reference } = input;

	// 1. Wallet
	if (wallet.playerId !== transaction.playerId) {
		return reject(FailureCode.WalletPlayerMismatch);
	}
	if (wallet.currency !== transaction.money.currency) {
		return reject(FailureCode.WalletCurrencyMismatch);
	}

	// 2. Reference
	if (transaction.referenceExternalTransactionId !== undefined) {
		const referenceDecision = checkReference(transaction, reference);
		if (referenceDecision !== undefined) {
			return referenceDecision;
		}
	}

	// 3. Apply
	if (!transaction.affectsBalance()) {
		return { type: "APPLY", direction: undefined };
	}
	const direction = transaction.ledgerDirectionFor(reference?.transaction);
	if (
		direction === LedgerDirection.Debit &&
		wallet.balance.isLessThan(transaction.money)
	) {
		return reject(
			transaction.kind === Kind.Bet
				? FailureCode.InsufficientFunds
				: FailureCode.ReversalWouldOverdraw,
		);
	}
	return { type: "APPLY", direction };
}

/** Returns a decision to stop on, or `undefined` when the reference is acceptable. */
function checkReference(
	transaction: WagerTransaction,
	reference: ReferenceFacts | undefined,
): TransactionDecision | undefined {
	if (reference === undefined) {
		return { type: "PENDING_REFERENCE" };
	}
	const referenced = reference.transaction;
	if (!ALLOWED_REFERENCE_KINDS[transaction.kind].includes(referenced.kind)) {
		return reject(FailureCode.ReferenceKindNotAllowed);
	}
	if (
		referenced.walletId !== transaction.walletId ||
		referenced.playerId !== transaction.playerId ||
		referenced.money.currency !== transaction.money.currency ||
		referenced.roundId !== transaction.roundId
	) {
		return reject(FailureCode.ReferenceMismatch);
	}
	if (
		transaction.requiresReference() &&
		!transaction.money.equals(referenced.money)
	) {
		return reject(FailureCode.ReversalAmountMismatch);
	}
	switch (referenced.status) {
		case Status.PendingReference:
			return { type: "PENDING_REFERENCE" };
		case Status.Rejected:
		case Status.Failed:
			return reject(FailureCode.ReferenceNotProcessed);
		case Status.Pending:
			// PENDING never leaves its own SQL transaction (design §12.7).
			throw new UnexpectedReferenceStateError(
				"a referenced transaction cannot be PENDING",
			);
		case Status.Processed:
			break;
	}
	if (reference.alreadyReversed) {
		return reject(FailureCode.ReferenceAlreadyReversed);
	}
	return undefined;
}
