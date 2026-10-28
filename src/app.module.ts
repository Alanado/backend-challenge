import { type DynamicModule, Module } from "@nestjs/common";
import { ConsumerRoleModule } from "./modules/messaging/infrastructure/consumer-role.module";
import { OutboxPublisherRoleModule } from "./modules/messaging/infrastructure/outbox-publisher-role.module";
import { HttpRoleModule } from "./modules/platform/infrastructure/http-role.module";
import { infrastructureModule } from "./modules/platform/infrastructure/infrastructure.module";
import { PendingWorkerRoleModule } from "./modules/wagering/infrastructure/pending-worker-role.module";
import type { AppConfig } from "./shared/config";

@Module({})
export class AppModule {}

/**
 * Composition root: the infrastructure module (config, ORM, pool, repositories) plus one module
 * per role whose ENABLE_* flag is on. A disabled role's module is never loaded
 * (see modules/platform/infrastructure/role-lifecycle.ts).
 */
export function appModule(config: AppConfig): DynamicModule {
	return {
		module: AppModule,
		imports: [
			infrastructureModule(config),
			...(config.enableHttp ? [HttpRoleModule] : []),
			...(config.enableConsumer ? [ConsumerRoleModule] : []),
			...(config.enableOutboxPublisher ? [OutboxPublisherRoleModule] : []),
			...(config.enablePendingWorker ? [PendingWorkerRoleModule] : []),
		],
	};
}
