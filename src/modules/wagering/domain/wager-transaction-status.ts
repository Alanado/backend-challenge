export enum WagerTransactionStatus {
	/** Accepted, not yet applied. Never observable from outside the SQL transaction. */
	Pending = "PENDING",
	/** Waiting for the referenced transaction. */
	PendingReference = "PENDING_REFERENCE",
	/** Applied (terminal). */
	Processed = "PROCESSED",
	/** Business rule violation (terminal). */
	Rejected = "REJECTED",
	/** Permanent infrastructure error (terminal, auditable). */
	Failed = "FAILED",
}
