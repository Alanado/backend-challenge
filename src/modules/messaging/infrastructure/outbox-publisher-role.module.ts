import { SQSClient } from "@aws-sdk/client-sqs";
import { Injectable, Module } from "@nestjs/common";
import type { Clock } from "../../../shared/clock";
import type { AppConfig } from "../../../shared/config";
import { createFaultInjector } from "../../../shared/fault-injector";
import { AppLogger } from "../../platform/application/log-fields";
import { MetricsPort } from "../../platform/application/metrics";
import { TransactionManager } from "../../platform/application/transaction-manager";
import { ActiveRoles } from "../../platform/infrastructure/active-roles";
import { PollingLoop } from "../../platform/infrastructure/polling-loop";
import { RoleLifecycle } from "../../platform/infrastructure/role-lifecycle";
import { APP_CONFIG, CLOCK } from "../../platform/infrastructure/tokens";
import { MessagePublisher } from "../application/message-publisher";
import { OutboxPublisher } from "../application/outbox-publisher";
import { OutboxRepository } from "../application/outbox-repository";
import { SqsMessagePublisher } from "./sqs-message-publisher";

/** Runs the outbox publisher loop (ENABLE_OUTBOX_PUBLISHER); `stop()` finishes the batch in flight. */
@Injectable()
export class OutboxPublisherRole extends RoleLifecycle {
	protected readonly role = "outbox-publisher" as const;
	private readonly loop: PollingLoop;

	constructor(
		active: ActiveRoles,
		publisher: OutboxPublisher,
		config: AppConfig,
		logger: AppLogger,
	) {
		super(active);
		this.loop = new PollingLoop(
			async () =>
				(await publisher.publishOnce()).claimed >= config.outbox.batch,
			config.outbox.pollMs,
			(error) => logger.error("outbox publisher cycle failed", {}, error),
		);
	}

	protected override start(): void {
		this.loop.start();
	}

	protected override async stop(): Promise<void> {
		await this.loop.stop();
	}
}

/** ENABLE_OUTBOX_PUBLISHER. See role-lifecycle.ts for the plug-in pattern. */
@Module({
	providers: [
		{
			provide: MessagePublisher,
			useFactory: (config: AppConfig) =>
				new SqsMessagePublisher({
					client: new SQSClient({
						region: config.sqs.region,
						endpoint: config.sqs.endpoint,
						credentials: {
							accessKeyId: config.sqs.accessKeyId,
							secretAccessKey: config.sqs.secretAccessKey,
						},
					}),
					queueUrl: config.sqs.eventsQueueUrl,
					queueName: config.sqs.eventsQueueName,
				}),
			inject: [APP_CONFIG],
		},
		{
			provide: OutboxPublisher,
			useFactory: (
				config: AppConfig,
				tm: TransactionManager,
				outbox: OutboxRepository,
				publisher: MessagePublisher,
				clock: Clock,
				metrics: MetricsPort,
				logger: AppLogger,
			) =>
				new OutboxPublisher({
					tm,
					outbox,
					publisher,
					clock,
					metrics,
					logger,
					faults: createFaultInjector(config.testFault),
					batchSize: config.outbox.batch,
					backoff: {
						baseMs: config.outbox.backoffBaseMs,
						capMs: config.outbox.backoffCapMs,
					},
				}),
			inject: [
				APP_CONFIG,
				TransactionManager,
				OutboxRepository,
				MessagePublisher,
				CLOCK,
				MetricsPort,
				AppLogger,
			],
		},
		{
			provide: OutboxPublisherRole,
			useFactory: (
				active: ActiveRoles,
				publisher: OutboxPublisher,
				config: AppConfig,
				logger: AppLogger,
			) => new OutboxPublisherRole(active, publisher, config, logger),
			inject: [ActiveRoles, OutboxPublisher, APP_CONFIG, AppLogger],
		},
	],
})
export class OutboxPublisherRoleModule {}
