import { Module } from "@nestjs/common";
import type { Clock } from "../../../shared/clock";
import type { IdGenerator } from "../../../shared/ids";
import { OutboxRepository } from "../../messaging/application/outbox-repository";
import { TransactionManager } from "../../platform/application/transaction-manager";
import { CLOCK, ID_GENERATOR } from "../../platform/infrastructure/tokens";
import { WagerTransactionRepository } from "../../wagering/application/wager-transaction-repository";
import { CreateWallet } from "../application/create-wallet";
import { GetWallet } from "../application/get-wallet";
import { LedgerRepository } from "../application/ledger-repository";
import { WalletRepository } from "../application/wallet-repository";
import { WalletController } from "./wallet.controller";

/** HTTP surface of the wallet module (loaded by the HTTP role). The ports come from the global infrastructure module. */
@Module({
	controllers: [WalletController],
	providers: [
		{
			provide: CreateWallet,
			useFactory: (
				tm: TransactionManager,
				wallets: WalletRepository,
				transactions: WagerTransactionRepository,
				ledger: LedgerRepository,
				outbox: OutboxRepository,
				clock: Clock,
				ids: IdGenerator,
			) =>
				new CreateWallet(tm, wallets, transactions, ledger, outbox, clock, ids),
			inject: [
				TransactionManager,
				WalletRepository,
				WagerTransactionRepository,
				LedgerRepository,
				OutboxRepository,
				CLOCK,
				ID_GENERATOR,
			],
		},
		{
			provide: GetWallet,
			useFactory: (wallets: WalletRepository) => new GetWallet(wallets),
			inject: [WalletRepository],
		},
	],
})
export class WalletHttpModule {}
