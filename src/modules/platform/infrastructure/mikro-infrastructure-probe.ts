import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { InfrastructureProbe } from "../application/infrastructure-probe";
import { releaseDeadClients } from "./pg-pool-reaper";

@Injectable()
export class MikroInfrastructureProbe extends InfrastructureProbe {
	constructor(private readonly em: EntityManager) {
		super();
	}

	async ping(): Promise<void> {
		try {
			await this.em.fork().execute("select 1");
		} catch (error) {
			// A dead connection must not keep its pool slot while the breaker waits for recovery.
			try {
				releaseDeadClients(await this.em.getConnection().getNativeClient());
			} catch {
				// Best effort: the failed probe is what the breaker needs to know.
			}
			throw error;
		}
	}
}
