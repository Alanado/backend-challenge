/** Stable, machine-readable catalog of recorded outcomes (04-api §4.1). */
export enum FailureCode {
	InsufficientFunds = "INSUFFICIENT_FUNDS",
	ReversalWouldOverdraw = "REVERSAL_WOULD_OVERDRAW",
	ReferenceNotFound = "REFERENCE_NOT_FOUND",
	ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
	ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
	ReferenceMismatch = "REFERENCE_MISMATCH",
	ReferenceKindNotAllowed = "REFERENCE_KIND_NOT_ALLOWED",
	ReversalAmountMismatch = "REVERSAL_AMOUNT_MISMATCH",
	WalletPlayerMismatch = "WALLET_PLAYER_MISMATCH",
	WalletCurrencyMismatch = "WALLET_CURRENCY_MISMATCH",
	ProcessingAttemptsExhausted = "PROCESSING_ATTEMPTS_EXHAUSTED",
}
