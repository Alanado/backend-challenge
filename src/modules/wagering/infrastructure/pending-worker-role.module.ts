import { Injectable, Module } from "@nestjs/common";
import { ActiveRoles } from "../../platform/infrastructure/active-roles";
import { RoleLifecycle } from "../../platform/infrastructure/role-lifecycle";

@Injectable()
export class PendingWorkerRole extends RoleLifecycle {
	protected readonly role = "pending-worker" as const;

	constructor(active: ActiveRoles) {
		super(active);
	}
	// T-043 overrides start()/stop() to run the PENDING_REFERENCE worker.
}

/** ENABLE_PENDING_WORKER. See role-lifecycle.ts for the plug-in pattern. */
@Module({ providers: [PendingWorkerRole] })
export class PendingWorkerRoleModule {}
