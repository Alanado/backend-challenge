import { MikroOrmModule } from "@mikro-orm/nestjs";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { type DynamicModule, Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import type { AppConfig } from "../../../shared/config";
import { InboxRepository } from "../../messaging/application/inbox-repository";
import { OutboxRepository } from "../../messaging/application/outbox-repository";
import { InboxMessageSchema } from "../../messaging/infrastructure/inbox-message.schema";
import { MikroInboxRepository } from "../../messaging/infrastructure/mikro-inbox.repository";
import { MikroOutboxRepository } from "../../messaging/infrastructure/mikro-outbox.repository";
import { OutboxMessageSchema } from "../../messaging/infrastructure/outbox-message.schema";
import { WagerTransactionRepository } from "../../wagering/application/wager-transaction-repository";
import { MikroWagerTransactionRepository } from "../../wagering/infrastructure/mikro-wager-transaction.repository";
import { WagerTransactionSchema } from "../../wagering/infrastructure/wager-transaction.schema";
import { LedgerRepository } from "../../wallet/application/ledger-repository";
import { WalletRepository } from "../../wallet/application/wallet-repository";
import { LedgerEntrySchema } from "../../wallet/infrastructure/ledger-entry.schema";
import { MikroLedgerRepository } from "../../wallet/infrastructure/mikro-ledger.repository";
import { MikroWalletRepository } from "../../wallet/infrastructure/mikro-wallet.repository";
import { WalletSchema } from "../../wallet/infrastructure/wallet.schema";
import { AppLogger } from "../application/log-fields";
import { MetricsPort } from "../application/metrics";
import { TransactionManager } from "../application/transaction-manager";
import { ActiveRoles } from "./active-roles";
import { MikroTransactionManager } from "./mikro-transaction-manager";
import { createPinoLogger, PinoAppLogger } from "./pino-logger";
import { PromMetrics } from "./prom-metrics";
import { APP_CONFIG } from "./tokens";
import { TransactionRunner, TransactionTimeouts } from "./transaction-runner";

@Module({})
export class InfrastructureModule {}

export function infrastructureModule(config: AppConfig): DynamicModule {
	// One pino instance for the whole process: our own lines and Nest's framework lines.
	const pinoLogger = createPinoLogger({ level: config.logLevel });
	return {
		module: InfrastructureModule,
		global: true,
		imports: [
			// Only the bridge for Nest's own logger; access logging is ours (CorrelationIdMiddleware).
			LoggerModule.forRoot({
				pinoHttp: { logger: pinoLogger, autoLogging: false },
			}),
			MikroOrmModule.forRoot({
				driver: PostgreSqlDriver,
				clientUrl: config.databaseUrl,
				entities: [
					WalletSchema,
					LedgerEntrySchema,
					WagerTransactionSchema,
					InboxMessageSchema,
					OutboxMessageSchema,
				],
				discovery: { warnWhenNoEntities: false },
				pool: { min: 0, max: config.dbPoolMax },
			}),
		],
		providers: [
			{ provide: APP_CONFIG, useValue: config },
			{ provide: AppLogger, useValue: new PinoAppLogger(pinoLogger) },
			{
				provide: TransactionTimeouts,
				useValue: new TransactionTimeouts(
					config.lockTimeoutMs,
					config.statementTimeoutMs,
				),
			},
			TransactionRunner,
			ActiveRoles,
			PromMetrics,
			{ provide: MetricsPort, useExisting: PromMetrics },
			MikroTransactionManager,
			MikroWalletRepository,
			MikroLedgerRepository,
			MikroWagerTransactionRepository,
			MikroInboxRepository,
			MikroOutboxRepository,
			// Application ports resolve to the MikroORM adapters.
			{ provide: TransactionManager, useExisting: MikroTransactionManager },
			{ provide: WalletRepository, useExisting: MikroWalletRepository },
			{ provide: LedgerRepository, useExisting: MikroLedgerRepository },
			{
				provide: WagerTransactionRepository,
				useExisting: MikroWagerTransactionRepository,
			},
			{ provide: InboxRepository, useExisting: MikroInboxRepository },
			{ provide: OutboxRepository, useExisting: MikroOutboxRepository },
		],
		exports: [
			APP_CONFIG,
			AppLogger,
			MetricsPort,
			PromMetrics,
			ActiveRoles,
			TransactionRunner,
			TransactionManager,
			WalletRepository,
			LedgerRepository,
			WagerTransactionRepository,
			InboxRepository,
			OutboxRepository,
		],
	};
}
