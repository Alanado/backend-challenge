import { AsyncLocalStorage } from "node:async_hooks";
import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import {
	InfrastructureUnavailableError,
	TransactionRequiredError,
} from "../application/persistence-errors";
import { TransactionManager } from "../application/transaction-manager";
import { translatePersistenceError } from "./persistence-error-translation";
import { releaseDeadClients } from "./pg-pool-reaper";
import { TransactionRunner } from "./transaction-runner";

/**
 * `TransactionManager` on MikroORM. The transaction's EntityManager travels in an
 * AsyncLocalStorage, so ports stay free of any handle: repositories ask `current()`.
 */
@Injectable()
export class MikroTransactionManager extends TransactionManager {
	private readonly context = new AsyncLocalStorage<EntityManager>();

	constructor(
		private readonly em: EntityManager,
		private readonly runner: TransactionRunner,
	) {
		super();
	}

	async run<T>(work: () => Promise<T>): Promise<T> {
		// Nested run joins the open transaction (no savepoints): one unit of work, one commit.
		if (this.context.getStore() !== undefined) return work();
		try {
			return await this.runner.run((tx) => this.context.run(tx, work));
		} catch (error) {
			const translated = translatePersistenceError(error);
			if (translated instanceof InfrastructureUnavailableError) {
				await this.reclaimDeadConnections();
			}
			throw translated;
		}
	}

	/** The transaction's EntityManager, or a fresh fork (autocommit) outside `run`. */
	current(): EntityManager {
		return this.context.getStore() ?? this.em.fork();
	}

	/** For locks and writes that only make sense inside `run`. */
	requireTransaction(operation: string): EntityManager {
		const tx = this.context.getStore();
		if (tx === undefined) throw new TransactionRequiredError(operation);
		return tx;
	}

	/** See pg-pool-reaper.ts: a transaction that died with its connection leaves the pool slot taken. */
	private async reclaimDeadConnections(): Promise<void> {
		try {
			releaseDeadClients(await this.em.getConnection().getNativeClient());
		} catch {
			// Best effort: the original failure is what the caller must see.
		}
	}
}
