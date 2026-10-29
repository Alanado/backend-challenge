import type { SQSClient } from "@aws-sdk/client-sqs";
import type { Client } from "pg";
import { eventually } from "../support/eventually";
import type { TestWallet } from "../support/http-app";
import {
	createWalletOn,
	mapPool,
	type Op,
	op,
	sendOn,
} from "../support/multi-instance";
import type { Persistence } from "../support/persistence";
import type { Instance } from "../support/spawnApp";
import { queueDepth } from "../support/sqs-poller";
import type { SuiteQueues } from "../support/suite-queues";
import { submitTimed } from "./lib/client";
import {
	amountOf,
	peekRandom,
	pickAction,
	seededRandom,
	takeRandom,
} from "./lib/generators";
import {
	LatencyRecorder,
	type LatencySummary,
	type Outcome,
	OutcomeTally,
	throughput,
} from "./lib/measurement";
import { delta, LagSampler, snapshot } from "./lib/observe";
import { runTimed } from "./lib/runner";
import { verifyConsistency, waitOutboxDrained } from "./lib/verify";
import type { Profile } from "./profiles";

export interface Context {
	instances: readonly Instance[];
	sql: Client;
	p: Persistence;
	sqs: SQSClient;
	queues: SuiteQueues;
	profile: Profile;
	seed: number;
}

export interface ScenarioResult {
	id: string;
	name: string;
	channel: "http" | "sqs";
	issued: number;
	measured: number;
	measuredMs: number;
	throughputPerSecond: number;
	latency: LatencySummary;
	statuses: Record<string, number>;
	unexpectedErrors: number;
	recoveredResets: number;
	errorRate: number;
	lockConflicts: number;
	idempotentRequests: number;
	transactions: Record<string, number>;
	outboxLagMaxSeconds: number;
	outboxLagFinalSeconds: number;
	generatorCpuPercent: number;
	walletsTouched: number;
	violations: string[];
}

interface Body {
	latency: LatencyRecorder;
	tally: OutcomeTally;
	issued: number;
	measuredMs: number;
	generatorCpuPercent: number;
	walletIds: string[];
	betOnlyInitialBalance?: string;
}

export interface Scenario {
	id: string;
	name: string;
	channel: "http" | "sqs";
	run(ctx: Context): Promise<Body>;
}

const INITIAL_BALANCE = "1000000.00";

function roundRobin(ctx: Context): () => string {
	let n = 0;
	return () => (ctx.instances[n++ % ctx.instances.length] as Instance).base;
}

async function createWallets(
	ctx: Context,
	count: number,
): Promise<TestWallet[]> {
	const next = roundRobin(ctx);
	return mapPool(Array.from({ length: count }), 16, () =>
		createWalletOn(next(), INITIAL_BALANCE),
	);
}

async function betLoop(
	ctx: Context,
	wallets: readonly TestWallet[],
	concurrency: number,
	salt: number,
): Promise<Body> {
	const next = roundRobin(ctx);
	const rolls = Array.from({ length: concurrency }, (_, i) =>
		seededRandom(ctx.seed + salt + i),
	);
	const run = await runTimed({
		concurrency,
		warmupMs: ctx.profile.warmupMs,
		measureMs: ctx.profile.measureMs,
		step: (worker) => {
			const roll = rolls[worker] as () => number;
			const wallet = wallets[Math.floor(roll() * wallets.length)] as TestWallet;
			const bet = op("BET", amountOf(1 + Math.floor(roll() * 5)));
			return submitTimed(next(), wallet, bet, ctx.profile.requestTimeoutMs);
		},
	});
	return {
		latency: run.latency,
		tally: run.tally,
		issued: run.issued,
		measuredMs: run.measuredMs,
		generatorCpuPercent: run.generatorCpuPercent,
		walletIds: wallets.map((w) => w.id),
		betOnlyInitialBalance: INITIAL_BALANCE,
	};
}

const n1: Scenario = {
	id: "N1",
	name: "many wallets (HTTP)",
	channel: "http",
	async run(ctx) {
		const wallets = await createWallets(ctx, ctx.profile.n1.wallets);
		return betLoop(ctx, wallets, ctx.profile.n1.concurrency, 100);
	},
};

const n2: Scenario = {
	id: "N2",
	name: "hot wallet (HTTP)",
	channel: "http",
	async run(ctx) {
		const wallets = await createWallets(ctx, 1);
		return betLoop(ctx, wallets, ctx.profile.n2.concurrency, 200);
	},
};

interface Completed {
	wallet: TestWallet;
	operation: Op;
}

const n3: Scenario = {
	id: "N3",
	name: "mixed operations (HTTP)",
	channel: "http",
	async run(ctx) {
		const wallets = await createWallets(ctx, ctx.profile.n3.wallets);
		const next = roundRobin(ctx);
		const concurrency = ctx.profile.n3.concurrency;
		const rolls = Array.from({ length: concurrency }, (_, i) =>
			seededRandom(ctx.seed + 300 + i),
		);
		// Processed BETs: `referable` is consumed (one follow-up each), `replayable` is only re-sent.
		const referable: Completed[] = [];
		const replayable: Completed[] = [];
		const submit = (wallet: TestWallet, operation: Op) =>
			submitTimed(next(), wallet, operation, ctx.profile.requestTimeoutMs);

		const run = await runTimed({
			concurrency,
			warmupMs: ctx.profile.warmupMs,
			measureMs: ctx.profile.measureMs,
			step: async (worker): Promise<Outcome> => {
				const roll = rolls[worker] as () => number;
				const action = pickAction(roll());
				if (action === "DUPLICATE") {
					const original = peekRandom(replayable, roll());
					if (original !== undefined) {
						return submit(original.wallet, original.operation);
					}
				} else if (action !== "BET") {
					const bet = takeRandom(referable, roll());
					if (bet !== undefined) {
						const follow =
							action === "WIN"
								? op("WIN", "2.00", bet.operation)
								: op(action, bet.operation.amount, bet.operation);
						return submit(bet.wallet, follow);
					}
				}
				const wallet = wallets[
					Math.floor(roll() * wallets.length)
				] as TestWallet;
				const bet = op("BET", amountOf(1 + Math.floor(roll() * 5)));
				const outcome = await submit(wallet, bet);
				if (outcome.kind === "http" && outcome.status === 201) {
					const done = { wallet, operation: bet };
					referable.push(done);
					if (replayable.length < 2000) replayable.push(done);
				}
				return outcome;
			},
		});
		return {
			latency: run.latency,
			tally: run.tally,
			issued: run.issued,
			measuredMs: run.measuredMs,
			generatorCpuPercent: run.generatorCpuPercent,
			walletIds: wallets.map((w) => w.id),
		};
	},
};

/** N4: messages straight onto the input queue; latency is enqueue -> `processed_at`. */
const n4: Scenario = {
	id: "N4",
	name: "SQS consumption",
	channel: "sqs",
	async run(ctx) {
		const { messages, senders } = ctx.profile.n4;
		const wallets = await createWallets(ctx, ctx.profile.n4.wallets);
		const roll = seededRandom(ctx.seed + 400);
		const plan = Array.from({ length: messages }, () => ({
			wallet: wallets[Math.floor(roll() * wallets.length)] as TestWallet,
			operation: op("BET", amountOf(1 + Math.floor(roll() * 5))),
		}));

		const tally = new OutcomeTally();
		const sentAt = new Map<string, number>();
		const cpuStart = process.cpuUsage();
		const startedAt = performance.now();
		const startedEpochMs = Date.now();
		await mapPool(plan, senders, async (entry) => {
			sentAt.set(entry.operation.externalTransactionId, Date.now());
			try {
				await sendOn(ctx.sqs, ctx.queues, entry.wallet, entry.operation);
				// Here "200" only means the broker accepted the message.
				tally.add({ kind: "http", status: 200 });
			} catch {
				tally.add({ kind: "connection" });
			}
		});
		const accepted = tally.total - tally.unexpected;

		const ids = wallets.map((w) => w.id);
		await eventually(
			async () => {
				const done = await ctx.sql.query(
					"select count(*)::int as n from wager_transactions where wallet_id = any($1::uuid[])",
					[ids],
				);
				if (done.rows[0].n < accepted) {
					throw new Error(`${done.rows[0].n}/${accepted} consumed`);
				}
			},
			{ timeout: 120_000, interval: 200 },
		);
		const cpu = process.cpuUsage(cpuStart);
		const wallMs = performance.now() - startedAt;

		const rows = await ctx.sql.query(
			`select external_transaction_id as id,
			        extract(epoch from processed_at) * 1000 as processed_ms
			   from wager_transactions
			  where wallet_id = any($1::uuid[]) and processed_at is not null`,
			[ids],
		);
		const latency = new LatencyRecorder();
		let lastProcessedMs = startedEpochMs;
		for (const row of rows.rows) {
			const sent = sentAt.get(row.id as string);
			if (sent === undefined) continue;
			const processed = Number(row.processed_ms);
			latency.record(Math.max(0, processed - sent));
			lastProcessedMs = Math.max(lastProcessedMs, processed);
		}
		return {
			latency,
			tally,
			issued: messages,
			measuredMs: lastProcessedMs - startedEpochMs,
			generatorCpuPercent: ((cpu.user + cpu.system) / 1000 / wallMs) * 100,
			walletIds: ids,
			betOnlyInitialBalance: INITIAL_BALANCE,
		};
	},
};

export const SCENARIOS: readonly Scenario[] = [n1, n2, n3, n4];

/** Runs one scenario with metrics deltas, outbox lag samples and the consistency checks. */
export async function runScenario(
	scenario: Scenario,
	ctx: Context,
): Promise<ScenarioResult> {
	const before = await snapshot(ctx.instances);
	const lag = new LagSampler(ctx.instances);
	lag.start();
	const body = await scenario.run(ctx);
	await waitOutboxDrained(ctx.sql);
	const finalLag = await eventually(
		async () => {
			const current = await lag.sample();
			if (current > 1) throw new Error(`outbox lag still ${current}s`);
			return current;
		},
		{ timeout: 30_000, interval: 200 },
	);
	const maxLag = await lag.stop();
	const metrics = delta(await snapshot(ctx.instances), before);

	const violations = await verifyConsistency({
		p: ctx.p,
		sql: ctx.sql,
		walletIds: body.walletIds,
		...(body.betOnlyInitialBalance === undefined
			? {}
			: { betOnlyInitialBalance: body.betOnlyInitialBalance }),
	});
	if (scenario.channel === "sqs") {
		const dead = await queueDepth(ctx.sqs, ctx.queues.dlq.url);
		if (dead !== 0) violations.push(`${dead} messages in the DLQ`);
	}
	if (body.tally.unexpected > 0) {
		violations.push(
			`${body.tally.unexpected} unexpected outcomes (${JSON.stringify(body.tally.byStatus())})`,
		);
	}

	const summary = body.latency.summarize();
	return {
		id: scenario.id,
		name: scenario.name,
		channel: scenario.channel,
		issued: body.issued,
		measured: summary.count,
		measuredMs: body.measuredMs,
		throughputPerSecond: throughput(summary.count, body.measuredMs),
		latency: summary,
		statuses: body.tally.byStatus(),
		unexpectedErrors: body.tally.unexpected,
		recoveredResets: body.tally.recoveredResets,
		errorRate: body.tally.errorRate,
		lockConflicts: metrics.lockConflicts,
		idempotentRequests: metrics.idempotentRequests,
		transactions: metrics.transactions,
		outboxLagMaxSeconds: maxLag,
		outboxLagFinalSeconds: finalLag,
		generatorCpuPercent: body.generatorCpuPercent,
		walletsTouched: body.walletIds.length,
		violations,
	};
}
