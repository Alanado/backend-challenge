import type { Provider } from "@nestjs/common";
import type { Clock } from "../../../shared/clock";
import type { AppConfig } from "../../../shared/config";
import { createFaultInjector } from "../../../shared/fault-injector";
import type { IdGenerator } from "../../../shared/ids";
import { InboxRepository } from "../../messaging/application/inbox-repository";
import { OutboxRepository } from "../../messaging/application/outbox-repository";
import { AppLogger } from "../../platform/application/log-fields";
import { MetricsPort } from "../../platform/application/metrics";
import { TransactionManager } from "../../platform/application/transaction-manager";
import {
	APP_CONFIG,
	CLOCK,
	ID_GENERATOR,
} from "../../platform/infrastructure/tokens";
import { LedgerRepository } from "../../wallet/application/ledger-repository";
import { WalletRepository } from "../../wallet/application/wallet-repository";
import { SubmitWagerTransaction } from "../application/submit-wager-transaction";
import { WagerTransactionRepository } from "../application/wager-transaction-repository";

/**
 * The one use case of the financial pipeline, wired once. The HTTP role and the SQS consumer role
 * each list this provider, so both channels run the very same class (RF-MSG-01).
 */
export const submitWagerTransactionProvider: Provider = {
	provide: SubmitWagerTransaction,
	useFactory: (
		config: AppConfig,
		tm: TransactionManager,
		wallets: WalletRepository,
		transactions: WagerTransactionRepository,
		ledger: LedgerRepository,
		outbox: OutboxRepository,
		inbox: InboxRepository,
		clock: Clock,
		ids: IdGenerator,
		metrics: MetricsPort,
		logger: AppLogger,
	) =>
		new SubmitWagerTransaction({
			tm,
			wallets,
			transactions,
			ledger,
			outbox,
			inbox,
			clock,
			ids,
			metrics,
			logger,
			faults: createFaultInjector(config.testFault),
			referenceBackoff: {
				maxAttempts: config.pendingRef.maxAttempts,
				baseMs: config.pendingRef.baseMs,
				factor: config.pendingRef.factor,
				capMs: config.pendingRef.capMs,
			},
		}),
	inject: [
		APP_CONFIG,
		TransactionManager,
		WalletRepository,
		WagerTransactionRepository,
		LedgerRepository,
		OutboxRepository,
		InboxRepository,
		CLOCK,
		ID_GENERATOR,
		MetricsPort,
		AppLogger,
	],
};
