import type { SQSClient } from "@aws-sdk/client-sqs";
import type { Client } from "pg";
import type { MessageHandler } from "../../src/modules/messaging/application/message-consumer";
import { SqsDeadLetterQueue } from "../../src/modules/messaging/infrastructure/sqs-dead-letter-queue";
import { SqsMessageConsumer } from "../../src/modules/messaging/infrastructure/sqs-message-consumer";
import { RecordExhaustedTransaction } from "../../src/modules/wagering/application/record-exhausted-transaction";
import { WagerTransactionMessageHandler } from "../../src/modules/wagering/application/wager-transaction-message-handler";
import {
	type CrashFn,
	createFaultInjector,
} from "../../src/shared/fault-injector";
import { Uuidv7Generator } from "../../src/shared/ids";
import { openWalletWithOpening } from "./domain-builders";
import { newSqsClient } from "./event-consumer";
import { uniqueId } from "./ids";
import {
	createPersistence,
	type Persistence,
	type PersistenceOptions,
} from "./persistence";
import { connect } from "./sql";
import { sendMessage } from "./sqs-poller";
import { createSubmitHarness, type SubmitHarness } from "./submit-harness";
import { createSuiteDatabase, type SuiteDatabase } from "./suite-database";
import {
	createSuiteQueues,
	type SuiteQueues,
	type SuiteQueuesOptions,
} from "./suite-queues";

export interface TestWallet {
	id: string;
	playerId: string;
}

export interface WagerMessageOptions {
	messageId?: string;
	externalTransactionId?: string;
	idempotencyKey?: string;
	kind?: string;
	amount?: string;
	currency?: string;
	reference?: string;
	occurredAt?: string;
}

export interface WagerMessage {
	body: string;
	messageId: string;
	externalTransactionId: string;
	idempotencyKey: string;
}

/** A `WagerTransactionRequested` for `wallet`; every id is fresh unless the test fixes it. */
export function wagerMessage(
	wallet: TestWallet,
	o: WagerMessageOptions = {},
): WagerMessage {
	const messageId = o.messageId ?? `msg-${uniqueId()}`;
	const externalTransactionId = o.externalTransactionId ?? `ext-${uniqueId()}`;
	const idempotencyKey =
		o.idempotencyKey ?? `provider-a:${externalTransactionId}`;
	const body = JSON.stringify({
		messageId,
		type: "WagerTransactionRequested",
		occurredAt: o.occurredAt ?? "2026-10-28T12:00:00.000Z",
		data: {
			providerId: "provider-a",
			externalTransactionId,
			idempotencyKey,
			playerId: wallet.playerId,
			walletId: wallet.id,
			roundId: "round-1",
			gameId: "game-1",
			kind: o.kind ?? "BET",
			money: { amount: o.amount ?? "25.00", currency: o.currency ?? "BRL" },
			...(o.reference === undefined
				? {}
				: { referenceExternalTransactionId: o.reference }),
		},
	});
	return { body, messageId, externalTransactionId, idempotencyKey };
}

export interface ConsumerOptions {
	/** `TEST_FAULT` crash hook of the consumer (in-process: throws instead of killing). */
	crash?: { point: string; fn: CrashFn };
	persistence?: PersistenceOptions;
	handlerTimeoutMs?: number;
	backoff?: { baseS: number; capS: number };
	/** SQS_MAX_RECEIVE (default 8, as in production). */
	maxReceive?: number;
	/** `TEST_FAULT` of the USE CASE (e.g. `fail-mid-transaction`), as opposed to `crash`. */
	useCaseFault?: string;
	waitTimeSeconds?: number;
	concurrency?: number;
	/** Wraps the registered handler (e.g. to count or to read the processing). */
	wrap?: (handler: WagerTransactionMessageHandler) => MessageHandler;
}

export interface ConsumerRig {
	p: Persistence;
	harness: SubmitHarness;
	handler: WagerTransactionMessageHandler;
	exhausted: RecordExhaustedTransaction;
	consumer: SqsMessageConsumer;
	client: SQSClient;
	/** Commands this consumer sent to SQS, in order (a spy over the real client). */
	commands: Array<{ name: string; input: Record<string, unknown> }>;
	close(): Promise<void>;
}

/** One consumer instance: its own pool, its own SQS client, the real use case, the real queue. */
export async function createConsumerRig(
	db: SuiteDatabase,
	queues: SuiteQueues,
	o: ConsumerOptions = {},
): Promise<ConsumerRig> {
	const p = await createPersistence(db.url, o.persistence);
	const harness = createSubmitHarness(p, { fault: o.useCaseFault ?? "" });
	const exhausted = new RecordExhaustedTransaction({
		tm: p.tm,
		wallets: p.wallets,
		transactions: p.transactions,
		outbox: p.outbox,
		inbox: p.inbox,
		clock: harness.clock,
		ids: new Uuidv7Generator(),
		metrics: harness.metrics,
	});
	const handler = new WagerTransactionMessageHandler({
		submit: harness.submit,
		exhausted,
		metrics: harness.metrics,
		logger: harness.logger,
		backoff: o.backoff ?? { baseS: 1, capS: 4 },
		maxReceive: o.maxReceive ?? 8,
	});
	const client = newSqsClient();
	const commands: ConsumerRig["commands"] = [];
	const send = client.send.bind(client) as (
		command: { constructor: { name: string }; input: object },
		...rest: unknown[]
	) => Promise<unknown>;
	(client as unknown as { send: typeof send }).send = (command, ...rest) => {
		commands.push({
			name: command.constructor.name,
			input: { ...command.input },
		});
		return send(command, ...rest);
	};
	const consumer = new SqsMessageConsumer({
		client,
		queueName: queues.main.name,
		concurrency: o.concurrency ?? 5,
		handlerTimeoutMs: o.handlerTimeoutMs ?? 10_000,
		waitTimeSeconds: o.waitTimeSeconds ?? 1,
		// The crash hook belongs to the consumer's ack step; the use case has its own injector.
		faults: createFaultInjector(o.crash?.point ?? "", o.crash?.fn),
		logger: harness.logger,
		metrics: harness.metrics,
		deadLetter: new SqsDeadLetterQueue({
			client,
			queueName: queues.dlq.name,
		}),
	});
	consumer.register(o.wrap?.(handler) ?? handler.handle);
	return {
		p,
		harness,
		handler,
		exhausted,
		consumer,
		client,
		commands,
		async close() {
			await consumer.stop();
			client.destroy();
			await p.close();
		},
	};
}

export interface ConsumerEnv {
	db: SuiteDatabase;
	queues: SuiteQueues;
	sql: Client;
	sqs: SQSClient;
	/** For setup and for reading back (ledger invariant); not a consumer. */
	p: Persistence;
	/** Sends `message` to the input queue (group = wallet unless `group` is given). */
	send(
		message: WagerMessage,
		wallet: TestWallet,
		group?: string,
	): Promise<void>;
	wallet(balance?: string): Promise<TestWallet>;
	rig(options?: ConsumerOptions): Promise<ConsumerRig>;
	close(): Promise<void>;
}

export async function createConsumerEnv(
	prefix: string,
	queueOptions: SuiteQueuesOptions = {},
): Promise<ConsumerEnv> {
	const db = await createSuiteDatabase();
	const queues = await createSuiteQueues(prefix, queueOptions);
	const sql = await connect(db.url);
	const sqs = newSqsClient();
	const p = await createPersistence(db.url);
	const rigs: ConsumerRig[] = [];
	return {
		db,
		queues,
		sql,
		sqs,
		p,
		send: (message, wallet, group) =>
			sendMessage(sqs, queues.main.url, message.body, group ?? wallet.id),
		async wallet(balance = "100.00") {
			const wallet = await openWalletWithOpening(p, balance);
			return { id: wallet.id, playerId: wallet.playerId };
		},
		async rig(options) {
			const rig = await createConsumerRig(db, queues, options);
			rigs.push(rig);
			return rig;
		},
		async close() {
			for (const rig of rigs) await rig.close();
			await p.close();
			await sql.end();
			sqs.destroy();
			await queues.destroy();
			await db.drop();
		},
	};
}

/** Balance, ledger size and the non-OPENING transaction rows of a wallet, read straight from the database. */
export async function walletState(sql: Client, walletId: string) {
	const [wallet, ledger, transactions] = await Promise.all([
		sql.query("select balance from wallets where id = $1", [walletId]),
		sql.query(
			"select count(*)::int as n from wallet_ledger_entries where wallet_id = $1",
			[walletId],
		),
		sql.query(
			"select status, failure_code from wager_transactions where wallet_id = $1 and kind <> 'OPENING' order by created_at, id",
			[walletId],
		),
	]);
	return {
		balance: String(wallet.rows[0].balance),
		ledgerEntries: Number(ledger.rows[0].n),
		transactions: transactions.rows as Array<{
			status: string;
			failure_code: string | null;
		}>,
	};
}

export async function inboxRows(sql: Client, messageId: string) {
	const result = await sql.query(
		"select consumer_name, payload_hash, processed_at from inbox_messages where message_id = $1",
		[messageId],
	);
	return result.rows as Array<{
		consumer_name: string;
		payload_hash: string;
		processed_at: Date | null;
	}>;
}
