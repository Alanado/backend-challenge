export enum WagerTransactionKind {
	/** Internal: wallet opening credit. Never submitted by API or queue. */
	Opening = "OPENING",
	Bet = "BET",
	Win = "WIN",
	Loss = "LOSS",
	Refund = "REFUND",
	Rollback = "ROLLBACK",
}
