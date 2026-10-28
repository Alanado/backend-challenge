import { DomainError } from "../../../shared/errors";

/** `UNIQUE (player_id, currency)` refused the insert (RF-WAL-01). */
export class WalletAlreadyExistsError extends DomainError {
	readonly code = "WALLET_ALREADY_EXISTS";

	constructor() {
		super("a wallet already exists for this player and currency");
	}
}

export class WalletNotFoundError extends DomainError {
	readonly code = "WALLET_NOT_FOUND";

	constructor() {
		super("wallet not found");
	}
}

/** The ledger `cursor` is not one this API issued (opaque base64url of a wallet version): 400 `INVALID_CURSOR`. */
export class InvalidCursorError extends DomainError {
	readonly code = "INVALID_CURSOR";

	constructor() {
		super("the cursor is not valid");
	}
}
