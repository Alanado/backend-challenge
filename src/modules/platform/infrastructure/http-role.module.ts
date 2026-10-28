import {
	Injectable,
	type MiddlewareConsumer,
	Module,
	type NestModule,
} from "@nestjs/common";
import { ActiveRoles } from "./active-roles";
import { CorrelationIdMiddleware } from "./correlation-id.middleware";
import { MetricsController } from "./metrics.controller";
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
	controllers: [MetricsController],
	providers: [HttpRole, CorrelationIdMiddleware],
})
export class HttpRoleModule implements NestModule {
	configure(consumer: MiddlewareConsumer): void {
		consumer.apply(CorrelationIdMiddleware).forRoutes("*");
	}
}
