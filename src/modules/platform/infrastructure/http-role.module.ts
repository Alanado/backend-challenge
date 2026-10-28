import { Injectable, Module } from "@nestjs/common";
import { ActiveRoles } from "./active-roles";
import { RoleLifecycle } from "./role-lifecycle";

@Injectable()
export class HttpRole extends RoleLifecycle {
	protected readonly role = "http" as const;

	constructor(active: ActiveRoles) {
		super(active);
	}
}

/** ENABLE_HTTP. Controllers (health, metrics, wagering, wallet) join `controllers` from W5 on. */
@Module({ providers: [HttpRole] })
export class HttpRoleModule {}
