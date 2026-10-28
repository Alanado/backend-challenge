import {
	Injectable,
	type MiddlewareConsumer,
	Module,
	type NestModule,
} from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { WageringHttpModule } from "../../wagering/infrastructure/wagering-http.module";
import { WalletHttpModule } from "../../wallet/infrastructure/wallet-http.module";
import { ActiveRoles } from "./active-roles";
import { AuthGuard } from "./auth.guard";
import { CorrelationIdMiddleware } from "./correlation-id.middleware";
import { MetricsController } from "./metrics.controller";
import { ProblemDetailsFilter } from "./problem-details.filter";
import { RoleLifecycle } from "./role-lifecycle";

@Injectable()
export class HttpRole extends RoleLifecycle {
	protected readonly role = "http" as const;

	constructor(active: ActiveRoles) {
		super(active);
	}
}

/** ENABLE_HTTP. Controllers (health, metrics, wagering, wallet) join `controllers` from W5 on. */
@Module({
	imports: [WalletHttpModule, WageringHttpModule],
	controllers: [MetricsController],
	providers: [
		HttpRole,
		CorrelationIdMiddleware,
		{ provide: APP_GUARD, useClass: AuthGuard },
		{ provide: APP_FILTER, useClass: ProblemDetailsFilter },
	],
})
export class HttpRoleModule implements NestModule {
	configure(consumer: MiddlewareConsumer): void {
		consumer.apply(CorrelationIdMiddleware).forRoutes("*");
	}
}
