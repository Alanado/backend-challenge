import { Injectable, Module } from "@nestjs/common";
import { ActiveRoles } from "../../platform/infrastructure/active-roles";
import { RoleLifecycle } from "../../platform/infrastructure/role-lifecycle";

@Injectable()
export class ConsumerRole extends RoleLifecycle {
	protected readonly role = "consumer" as const;

	constructor(active: ActiveRoles) {
		super(active);
	}
	// T-041 overrides start()/stop() to run and drain the SQS poller.
}

/** ENABLE_CONSUMER. See role-lifecycle.ts for the plug-in pattern. */
@Module({ providers: [ConsumerRole] })
export class ConsumerRoleModule {}
