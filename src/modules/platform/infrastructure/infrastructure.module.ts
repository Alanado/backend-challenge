import { MikroOrmModule } from "@mikro-orm/nestjs";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { type DynamicModule, Module } from "@nestjs/common";
import type { AppConfig } from "../../../shared/config";
import { APP_CONFIG } from "./tokens";
import { TransactionRunner, TransactionTimeouts } from "./transaction-runner";

@Module({})
export class InfrastructureModule {}

export function infrastructureModule(config: AppConfig): DynamicModule {
	return {
		module: InfrastructureModule,
		global: true,
		imports: [
			MikroOrmModule.forRoot({
				driver: PostgreSqlDriver,
				clientUrl: config.databaseUrl,
				entities: [],
				discovery: { warnWhenNoEntities: false },
				pool: { min: 0, max: config.dbPoolMax },
			}),
		],
		providers: [
			{ provide: APP_CONFIG, useValue: config },
			{
				provide: TransactionTimeouts,
				useValue: new TransactionTimeouts(
					config.lockTimeoutMs,
					config.statementTimeoutMs,
				),
			},
			TransactionRunner,
		],
		exports: [APP_CONFIG, TransactionRunner],
	};
}
