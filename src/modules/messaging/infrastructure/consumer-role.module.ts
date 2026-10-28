import { SQSClient } from "@aws-sdk/client-sqs";
import { Injectable, Module } from "@nestjs/common";
import type { Clock } from "../../../shared/clock";
import type { AppConfig } from "../../../shared/config";
import { createFaultInjector } from "../../../shared/fault-injector";
import type { IdGenerator } from "../../../shared/ids";
import { InfrastructureProbe } from "../../platform/application/infrastructure-probe";
import { AppLogger } from "../../platform/application/log-fields";
import { MetricsPort } from "../../platform/application/metrics";
import { TransactionManager } from "../../platform/application/transaction-manager";
import { ActiveRoles } from "../../platform/infrastructure/active-roles";
import { RoleLifecycle } from "../../platform/infrastructure/role-lifecycle";
import {
	APP_CONFIG,
	CLOCK,
	ID_GENERATOR,
} from "../../platform/infrastructure/tokens";
import { RecordExhaustedTransaction } from "../../wagering/application/record-exhausted-transaction";
import { SubmitWagerTransaction } from "../../wagering/application/submit-wager-transaction";
import { WagerTransactionMessageHandler } from "../../wagering/application/wager-transaction-message-handler";
import { WagerTransactionRepository } from "../../wagering/application/wager-transaction-repository";
import { submitWagerTransactionProvider } from "../../wagering/infrastructure/submit-wager-transaction.provider";
import { WalletRepository } from "../../wallet/application/wallet-repository";
import { CircuitBreaker } from "../application/circuit-breaker";
import { InboxRepository } from "../application/inbox-repository";
import { MessageConsumer } from "../application/message-consumer";
import { OutboxRepository } from "../application/outbox-repository";
import { SqsDeadLetterQueue } from "./sqs-dead-letter-queue";
import { SqsMessageConsumer } from "./sqs-message-consumer";

/** Runs the SQS consumer (ENABLE_CONSUMER); `stop()` waits for the handlers in flight. */
@Injectable()
export class ConsumerRole extends RoleLifecycle {
	protected readonly role = "consumer" as const;

	constructor(
		active: ActiveRoles,
		private readonly consumer: MessageConsumer,
		private readonly handler: WagerTransactionMessageHandler,
	) {
		super(active);
	}

	protected override start(): void {
		this.consumer.register(this.handler.handle);
		this.consumer.start();
	}

	protected override async stop(): Promise<void> {
		await this.consumer.stop();
	}
}

/** ENABLE_CONSUMER. See role-lifecycle.ts for the plug-in pattern. */
@Module({
	providers: [
		submitWagerTransactionProvider,
		{
			provide: CircuitBreaker,
			useFactory: (
				config: AppConfig,
				clock: Clock,
				probe: InfrastructureProbe,
				metrics: MetricsPort,
			) =>
				new CircuitBreaker({
					clock,
					cooldownMinMs: config.breaker.cooldownMinMs,
					cooldownMaxMs: config.breaker.cooldownMaxMs,
					probe: () => probe.ping(),
					metrics,
				}),
			inject: [APP_CONFIG, CLOCK, InfrastructureProbe, MetricsPort],
		},
		{
			provide: MessageConsumer,
			useFactory: (
				config: AppConfig,
				metrics: MetricsPort,
				logger: AppLogger,
				breaker: CircuitBreaker,
			) => {
				const client = new SQSClient({
					region: config.sqs.region,
					endpoint: config.sqs.endpoint,
					credentials: {
						accessKeyId: config.sqs.accessKeyId,
						secretAccessKey: config.sqs.secretAccessKey,
					},
				});
				return new SqsMessageConsumer({
					client,
					queueUrl: config.sqs.queueUrl,
					queueName: config.sqs.queueName,
					concurrency: config.sqs.concurrency,
					handlerTimeoutMs: config.sqs.handlerTimeoutMs,
					waitTimeSeconds: config.sqs.waitTimeSeconds,
					faults: createFaultInjector(config.testFault),
					logger,
					metrics,
					deadLetter: new SqsDeadLetterQueue({
						client,
						queueName: config.sqs.dlqName,
					}),
					gate: breaker,
				});
			},
			inject: [APP_CONFIG, MetricsPort, AppLogger, CircuitBreaker],
		},
		{
			provide: RecordExhaustedTransaction,
			useFactory: (
				tm: TransactionManager,
				wallets: WalletRepository,
				transactions: WagerTransactionRepository,
				outbox: OutboxRepository,
				inbox: InboxRepository,
				clock: Clock,
				ids: IdGenerator,
				metrics: MetricsPort,
			) =>
				new RecordExhaustedTransaction({
					tm,
					wallets,
					transactions,
					outbox,
					inbox,
					clock,
					ids,
					metrics,
				}),
			inject: [
				TransactionManager,
				WalletRepository,
				WagerTransactionRepository,
				OutboxRepository,
				InboxRepository,
				CLOCK,
				ID_GENERATOR,
				MetricsPort,
			],
		},
		{
			provide: WagerTransactionMessageHandler,
			useFactory: (
				config: AppConfig,
				submit: SubmitWagerTransaction,
				exhausted: RecordExhaustedTransaction,
				metrics: MetricsPort,
				logger: AppLogger,
				breaker: CircuitBreaker,
			) =>
				new WagerTransactionMessageHandler({
					submit,
					exhausted,
					metrics,
					logger,
					infrastructure: breaker,
					backoff: {
						baseS: config.sqs.backoffBaseS,
						capS: config.sqs.backoffCapS,
					},
					maxReceive: config.sqs.maxReceive,
				}),
			inject: [
				APP_CONFIG,
				SubmitWagerTransaction,
				RecordExhaustedTransaction,
				MetricsPort,
				AppLogger,
				CircuitBreaker,
			],
		},
		{
			provide: ConsumerRole,
			useFactory: (
				active: ActiveRoles,
				consumer: MessageConsumer,
				handler: WagerTransactionMessageHandler,
			) => new ConsumerRole(active, consumer, handler),
			inject: [ActiveRoles, MessageConsumer, WagerTransactionMessageHandler],
		},
	],
})
export class ConsumerRoleModule {}
