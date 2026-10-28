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
