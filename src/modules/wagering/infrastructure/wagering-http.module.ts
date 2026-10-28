import { Module } from "@nestjs/common";
import { GetWagerTransaction } from "../application/get-wager-transaction";
import { WagerTransactionRepository } from "../application/wager-transaction-repository";
import { submitWagerTransactionProvider } from "./submit-wager-transaction.provider";
import {
	ProviderTransactionsController,
	WageringController,
} from "./wagering.controller";

/** HTTP surface of the wagering module (loaded by the HTTP role). The ports come from the global infrastructure module. */
@Module({
	controllers: [WageringController, ProviderTransactionsController],
	providers: [
		{
			provide: GetWagerTransaction,
			useFactory: (transactions: WagerTransactionRepository) =>
				new GetWagerTransaction(transactions),
			inject: [WagerTransactionRepository],
		},
		submitWagerTransactionProvider,
	],
})
export class WageringHttpModule {}
