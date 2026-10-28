import { MikroORM, PostgreSqlDriver } from "@mikro-orm/postgresql";
import { InboxMessageSchema } from "../../src/modules/messaging/infrastructure/inbox-message.schema";
import { MikroInboxRepository } from "../../src/modules/messaging/infrastructure/mikro-inbox.repository";
import { MikroOutboxRepository } from "../../src/modules/messaging/infrastructure/mikro-outbox.repository";
import { OutboxMessageSchema } from "../../src/modules/messaging/infrastructure/outbox-message.schema";
import { MikroTransactionManager } from "../../src/modules/platform/infrastructure/mikro-transaction-manager";
import {
	TransactionRunner,
	TransactionTimeouts,
} from "../../src/modules/platform/infrastructure/transaction-runner";
import { MikroWagerTransactionRepository } from "../../src/modules/wagering/infrastructure/mikro-wager-transaction.repository";
import { WagerTransactionSchema } from "../../src/modules/wagering/infrastructure/wager-transaction.schema";
import { LedgerEntrySchema } from "../../src/modules/wallet/infrastructure/ledger-entry.schema";
import { LedgerIntegrityReader } from "../../src/modules/wallet/infrastructure/ledger-integrity.reader";
import { MikroLedgerRepository } from "../../src/modules/wallet/infrastructure/mikro-ledger.repository";
import { MikroWalletRepository } from "../../src/modules/wallet/infrastructure/mikro-wallet.repository";
import { WalletSchema } from "../../src/modules/wallet/infrastructure/wallet.schema";

export const persistenceSchemas = [
	WalletSchema,
	LedgerEntrySchema,
	WagerTransactionSchema,
	InboxMessageSchema,
	OutboxMessageSchema,
];

export interface PersistenceOptions {
	poolMax?: number;
	lockTimeoutMs?: number;
	statementTimeoutMs?: number;
	/** Receives every SQL statement MikroORM sends (queries, begin/commit included), in order. */
	onQuery?: (statement: string) => void;
}

/** The real adapters on a real pool, wired by hand (no Nest) for integration tests. */
export async function createPersistence(
	url: string,
	{
		poolMax = 5,
		lockTimeoutMs = 5000,
		statementTimeoutMs = 15000,
		onQuery,
	}: PersistenceOptions = {},
) {
	const orm = await MikroORM.init({
		driver: PostgreSqlDriver,
		clientUrl: url,
		entities: persistenceSchemas,
		pool: { min: 0, max: poolMax },
		discovery: { warnWhenNoEntities: false },
		...(onQuery === undefined
			? {}
			: { debug: ["query" as const], logger: onQuery }),
	});
	const runner = new TransactionRunner(
		orm.em,
		new TransactionTimeouts(lockTimeoutMs, statementTimeoutMs),
	);
	const tm = new MikroTransactionManager(orm.em, runner);
	return {
		orm,
		tm,
		wallets: new MikroWalletRepository(tm),
		transactions: new MikroWagerTransactionRepository(tm),
		ledger: new MikroLedgerRepository(tm),
		inbox: new MikroInboxRepository(tm),
		outbox: new MikroOutboxRepository(tm),
		ledgerIntegrity: new LedgerIntegrityReader(tm),
		/** Wallets created through the builders; `assertAllCreatedWalletsConsistent` checks them at the end. */
		created: [] as string[],
		close: () => orm.close(true),
	};
}

export type Persistence = Awaited<ReturnType<typeof createPersistence>>;
