import type {
	OnApplicationBootstrap,
	OnApplicationShutdown,
} from "@nestjs/common";
import type { ActiveRoles, RoleName } from "./active-roles";

/*
 * Role registration pattern (02-design §1, §8). Every instance can run four roles: HTTP, SQS
 * consumer, outbox publisher and pending-reference worker. Each role is a Nest module that
 * `AppModule` imports ONLY when its ENABLE_* flag is on; the module carries one provider that
 * extends `RoleLifecycle`. A later task plugs in by:
 *   1. putting its collaborators in that role module's `providers`;
 *   2. overriding `start()` (begin polling/consuming) and `stop()` (drain and release) in the
 *      role provider, which Nest calls on bootstrap and on shutdown.
 * Nothing else is touched: no `if (flag)` in the task's own code, because a disabled role's
 * module is simply never loaded.
 */
export abstract class RoleLifecycle
	implements OnApplicationBootstrap, OnApplicationShutdown
{
	protected abstract readonly role: RoleName;

	constructor(private readonly active: ActiveRoles) {}

	async onApplicationBootstrap(): Promise<void> {
		await this.start();
		this.active.register(this.role);
	}

	async onApplicationShutdown(): Promise<void> {
		this.active.unregister(this.role);
		await this.stop();
	}

	protected start(): Promise<void> | void {}

	protected stop(): Promise<void> | void {}
}
