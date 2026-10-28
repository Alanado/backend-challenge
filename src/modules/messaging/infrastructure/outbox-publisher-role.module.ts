import { Injectable, Module } from "@nestjs/common";
import { ActiveRoles } from "../../platform/infrastructure/active-roles";
import { RoleLifecycle } from "../../platform/infrastructure/role-lifecycle";

@Injectable()
export class OutboxPublisherRole extends RoleLifecycle {
	protected readonly role = "outbox-publisher" as const;

	constructor(active: ActiveRoles) {
		super(active);
	}
	// T-040 overrides start()/stop() to run the outbox publisher loop.
}

/** ENABLE_OUTBOX_PUBLISHER. See role-lifecycle.ts for the plug-in pattern. */
@Module({ providers: [OutboxPublisherRole] })
export class OutboxPublisherRoleModule {}
