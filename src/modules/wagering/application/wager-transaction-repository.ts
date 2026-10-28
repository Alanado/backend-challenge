import type { WagerTransaction } from "../domain/wager-transaction";

export abstract class WagerTransactionRepository {
	/**
	 * `INSERT … ON CONFLICT DO NOTHING` with no conflict target, so a clash on the idempotency key
	 * or on the external id both come back as `false` (ADR-0007). Take the wallet lock first.
	 */
	abstract insertIfAbsent(transaction: WagerTransaction): Promise<boolean>;
	abstract findById(id: string): Promise<WagerTransaction | undefined>;
	abstract findByIdempotencyKey(
		providerId: string,
		idempotencyKey: string,
	): Promise<WagerTransaction | undefined>;
	abstract findByExternalId(
		providerId: string,
		externalTransactionId: string,
	): Promise<WagerTransaction | undefined>;
	/** Requires an active transaction. */
	abstract findByIdForUpdate(id: string): Promise<WagerTransaction | undefined>;
	/**
	 * Writes the mutable state (status, outcome, reference and retry fields). The identity columns
	 * are immutable (trigger); `now` stamps `updated_at`, which the domain object does not carry.
	 */
	abstract update(transaction: WagerTransaction, now: Date): Promise<void>;
	/** A PROCESSED REFUND/ROLLBACK already points at `referenceId`. */
	abstract existsProcessedReversalOf(referenceId: string): Promise<boolean>;
	/**
	 * Schedules PENDING_REFERENCE transactions waiting for (`providerId`, `externalTransactionId`)
	 * for retry at `now`, restricted to the locked wallet (ADR-0007). Returns how many were woken.
	 */
	abstract wakeDependents(
		providerId: string,
		externalTransactionId: string,
		walletId: string,
		now: Date,
	): Promise<number>;
	/**
	 * Candidates for the pending-reference worker: PENDING_REFERENCE and due at `now`, oldest due
	 * first. NO lock (ADR-0013): the worker locks the wallet first and revalidates afterwards.
	 */
	abstract findDuePendingReferences(
		now: Date,
		limit: number,
	): Promise<PendingCandidate[]>;
}

export interface PendingCandidate {
	id: string;
	walletId: string;
}
