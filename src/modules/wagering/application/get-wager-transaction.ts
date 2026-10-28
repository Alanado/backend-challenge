import type { MoneyProps } from "../../../shared/money";
import type { WagerTransaction } from "../domain/wager-transaction";
import { TransactionNotFoundError } from "./errors";
import {
	toResult,
	type WagerTransactionResult,
} from "./submit-wager-transaction";
import type { WagerTransactionRepository } from "./wager-transaction-repository";

/** The result envelope of 04-api §2 plus the identifiers of the transaction. */
export interface WagerTransactionView extends WagerTransactionResult {
	id: string;
	providerId: string;
	externalTransactionId: string;
	walletId: string;
	kind: string;
	money: MoneyProps;
	referenceTransactionId: string | null;
	createdAt: string;
	processedAt: string | null;
}

function toView(transaction: WagerTransaction): WagerTransactionView {
	return {
		// Not a replay: this is a query, nothing was submitted.
		...toResult(transaction, false),
		id: transaction.id,
		providerId: transaction.providerId,
		externalTransactionId: transaction.externalTransactionId,
		walletId: transaction.walletId,
		kind: transaction.kind,
		money: transaction.money.toJSON(),
		referenceTransactionId: transaction.referenceTransactionId ?? null,
		createdAt: transaction.createdAt.toISOString(),
		processedAt: transaction.processedAt?.toISOString() ?? null,
	};
}

/** Plain reads of the current state, no lock (nothing is decided from them). */
export class GetWagerTransaction {
	constructor(private readonly transactions: WagerTransactionRepository) {}

	async byId(id: string): Promise<WagerTransactionView> {
		return this.orNotFound(await this.transactions.findById(id));
	}

	async byExternalId(
		providerId: string,
		externalTransactionId: string,
	): Promise<WagerTransactionView> {
		return this.orNotFound(
			await this.transactions.findByExternalId(
				providerId,
				externalTransactionId,
			),
		);
	}

	private orNotFound(
		transaction: WagerTransaction | undefined,
	): WagerTransactionView {
		if (transaction === undefined) throw new TransactionNotFoundError();
		return toView(transaction);
	}
}
