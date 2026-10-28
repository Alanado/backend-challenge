import { Injectable } from "@nestjs/common";

export type RoleName =
	| "http"
	| "consumer"
	| "outbox-publisher"
	| "pending-worker";

/** Which roles this instance is running (ENABLE_* flags); also what the boot line reports. */
@Injectable()
export class ActiveRoles {
	private readonly names = new Set<RoleName>();

	register(name: RoleName): void {
		this.names.add(name);
	}

	unregister(name: RoleName): void {
		this.names.delete(name);
	}

	list(): RoleName[] {
		return [...this.names];
	}
}
