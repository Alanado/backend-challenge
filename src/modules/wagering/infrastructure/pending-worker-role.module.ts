import { Injectable, Module } from "@nestjs/common";
import type { Clock } from "../../../shared/clock";
import type { AppConfig } from "../../../shared/config";
import type { IdGenerator } from "../../../shared/ids";
import { OutboxRepository } from "../../messaging/application/outbox-repository";
import { AppLogger } from "../../platform/application/log-fields";
import { MetricsPort } from "../../platform/application/metrics";
import { TransactionManager } from "../../platform/application/transaction-manager";
import { ActiveRoles } from "../../platform/infrastructure/active-roles";
import { PollingLoop } from "../../platform/infrastructure/polling-loop";
import { RoleLifecycle } from "../../platform/infrastructure/role-lifecycle";
import {
	APP_CONFIG,
	CLOCK,
	ID_GENERATOR,
} from "../../platform/infrastructure/tokens";
import { LedgerRepository } from "../../wallet/application/ledger-repository";
import { WalletRepository } from "../../wallet/application/wallet-repository";
import {
	DEFAULT_CANDIDATE_LIMIT,
	PendingReferenceWorker,
} from "../application/pending-reference-worker";
import { WagerTransactionRepository } from "../application/wager-transaction-repository";

/** Runs the PENDING_REFERENCE worker loop (ENABLE_PENDING_WORKER); `stop()` ends the transaction in progress. */
@Injectable()
export class PendingWorkerRole extends RoleLifecycle {
	protected readonly role = "pending-worker" as const;
	private readonly loop: PollingLoop;

	constructor(
		active: ActiveRoles,
		private readonly worker: PendingReferenceWorker,
		config: AppConfig,
		logger: AppLogger,
	) {
		super(active);
		this.loop = new PollingLoop(
			async () =>
				(await worker.runOnce()).candidates >= DEFAULT_CANDIDATE_LIMIT,
			config.pendingRef.pollMs,
			(error) => logger.error("pending reference pass failed", {}, error),
		);
	}

	protected override start(): void {
		this.loop.start();
	}

	protected override async stop(): Promise<void> {
		this.worker.stop();
		await this.loop.stop();
	}
}

/** ENABLE_PENDING_WORKER. See role-lifecycle.ts for the plug-in pattern. */
@Module({
	providers: [
		{
			provide: PendingReferenceWorker,
			useFactory: (
				config: AppConfig,
				tm: TransactionManager,
				wallets: WalletRepository,
				transactions: WagerTransactionRepository,
				ledger: LedgerRepository,
				outbox: OutboxRepository,
				clock: Clock,
				ids: IdGenerator,
				metrics: MetricsPort,
				logger: AppLogger,
			) =>
				new PendingReferenceWorker({
					tm,
					wallets,
					transactions,
					ledger,
					outbox,
					clock,
					ids,
					metrics,
					logger,
					referenceBackoff: {
						maxAttempts: config.pendingRef.maxAttempts,
						baseMs: config.pendingRef.baseMs,
						factor: config.pendingRef.factor,
						capMs: config.pendingRef.capMs,
					},
					concurrency: config.pendingRef.concurrency,
				}),
			inject: [
				APP_CONFIG,
				TransactionManager,
				WalletRepository,
				WagerTransactionRepository,
				LedgerRepository,
				OutboxRepository,
				CLOCK,
				ID_GENERATOR,
				MetricsPort,
				AppLogger,
			],
		},
		{
			provide: PendingWorkerRole,
			useFactory: (
				active: ActiveRoles,
				worker: PendingReferenceWorker,
				config: AppConfig,
				logger: AppLogger,
			) => new PendingWorkerRole(active, worker, config, logger),
			inject: [ActiveRoles, PendingReferenceWorker, APP_CONFIG, AppLogger],
		},
	],
})
export class PendingWorkerRoleModule {}
