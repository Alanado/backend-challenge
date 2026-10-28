import type { SQSClient } from "@aws-sdk/client-sqs";
import type { Client } from "pg";
import { assertLedgerInvariant } from "./assertLedgerInvariant";
import { wagerMessage } from "./consumer-env";
import type { Reply, TestWallet } from "./http-app";
import { uniqueId } from "./ids";
import type { Persistence } from "./persistence";
import { sendMessage } from "./sqs-poller";
import type { SuiteQueues } from "./suite-queues";

/** One business operation of a load test; the same `Op` can be delivered any number of times. */
export interface Op {
	kind: "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";
	amount: string;
	externalTransactionId: string;
	key: string;
	/** `referenceExternalTransactionId`. */
	reference?: string;
}

export function op(kind: Op["kind"], amount: string, reference?: Op): Op {
	const externalTransactionId = `ext-${uniqueId()}`;
	return {
		kind,
		amount,
		externalTransactionId,
		key: `provider-a:${externalTransactionId}`,
		...(reference === undefined
			? {}
			: { reference: reference.externalTransactionId }),
	};
}

async function json(response: Response): Promise<Reply> {
	const text = await response.text();
	let body: unknown = text;
	try {
		body = text === "" ? null : JSON.parse(text);
	} catch {
		// keep the raw text
	}
	return { status: response.status, headers: response.headers, body };
}

export async function createWalletOn(
	base: string,
	balance: string,
): Promise<TestWallet> {
	const playerId = crypto.randomUUID();
	const reply = await json(
		await fetch(`${base}/wallets`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				playerId,
				initialBalance: { amount: balance, currency: "BRL" },
			}),
		}),
	);
	if (reply.status !== 201) {
		throw new Error(
			`createWallet: ${reply.status} ${JSON.stringify(reply.body)}`,
		);
	}
	return { id: reply.body.id as string, playerId, currency: "BRL" };
}

/** `POST /wagering/transactions` on the instance at `base`. Network failures propagate. */
export async function submitOn(
	base: string,
	wallet: TestWallet,
	operation: Op,
): Promise<Reply> {
	return json(
		await fetch(`${base}/wagering/transactions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Idempotency-Key": operation.key,
			},
			body: JSON.stringify({
				providerId: "provider-a",
				externalTransactionId: operation.externalTransactionId,
				playerId: wallet.playerId,
				walletId: wallet.id,
				roundId: "round-1",
				gameId: "game-1",
				kind: operation.kind,
				money: { amount: operation.amount, currency: "BRL" },
				...(operation.reference === undefined
					? {}
					: { referenceExternalTransactionId: operation.reference }),
			}),
		}),
	);
}

/** Puts `operation` on the input queue as a fresh message (new `messageId`, same business key). */
export async function sendOn(
	sqs: SQSClient,
	queues: SuiteQueues,
	wallet: TestWallet,
	operation: Op,
): Promise<void> {
	const message = wagerMessage(wallet, {
		externalTransactionId: operation.externalTransactionId,
		idempotencyKey: operation.key,
		kind: operation.kind,
		amount: operation.amount,
		...(operation.reference === undefined
			? {}
			: { reference: operation.reference }),
	});
	await sendMessage(sqs, queues.main.url, message.body, wallet.id);
}

export async function walletBalance(
	sql: Client,
	walletId: string,
): Promise<string> {
	const result = await sql.query("select balance from wallets where id = $1", [
		walletId,
	]);
	return String(result.rows[0].balance);
}

/** `pg_stat_database.deadlocks` of one database (cumulative since its creation). */
export async function deadlocksOf(
	sql: Client,
	database: string,
): Promise<number> {
	const result = await sql.query(
		"select deadlocks::int as n from pg_stat_database where datname = $1",
		[database],
	);
	return Number(result.rows[0].n);
}

export async function assertAllConsistent(
	p: Persistence,
	walletIds: readonly string[],
): Promise<void> {
	for (const id of walletIds)
		await assertLedgerInvariant(p.ledgerIntegrity, id);
}

/** Fisher-Yates with a seeded generator, so a failing order can be reproduced. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
	const out = [...items];
	let state = seed >>> 0 || 1;
	const next = () => {
		state ^= state << 13;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state / 2 ** 32;
	};
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[out[i], out[j]] = [out[j] as T, out[i] as T];
	}
	return out;
}

/** Runs `work` over `items` with at most `limit` in flight (all in parallel up to the limit). */
export async function mapPool<T, R>(
	items: readonly T[],
	limit: number,
	work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const lane = async (): Promise<void> => {
		for (let i = next++; i < items.length; i = next++) {
			results[i] = await work(items[i] as T, i);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, lane),
	);
	return results;
}
