import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";

/** Class token (DI by type, no parameter decorator) carrying the per-transaction timeouts. */
export class TransactionTimeouts {
	constructor(
		readonly lockTimeoutMs: number,
		readonly statementTimeoutMs: number,
	) {}
}

/**
 * Runs `work` in a transaction on a forked EntityManager. `SET LOCAL` scopes the timeouts to the
 * transaction (ADR-0006), so they never leak to the pooled connection afterwards.
 */
@Injectable()
export class TransactionRunner {
	constructor(
		private readonly em: EntityManager,
		private readonly timeouts: TransactionTimeouts,
	) {}

	run<T>(work: (tx: EntityManager) => Promise<T>): Promise<T> {
		const { lockTimeoutMs, statementTimeoutMs } = this.timeouts;
		return this.em.fork().transactional(async (tx) => {
			// Both values are validated integers (config), so interpolation is safe; SET does not take binds.
			await tx.execute(`set local lock_timeout = '${lockTimeoutMs}ms'`);
			await tx.execute(
				`set local statement_timeout = '${statementTimeoutMs}ms'`,
			);
			return work(tx);
		});
	}
}
