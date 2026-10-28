import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import type { WagerTransactionRepository } from "../../src/modules/wagering/application/wager-transaction-repository";
import type { ReferenceBackoffConfig } from "../../src/modules/wagering/domain/reference-backoff";
import { WagerTransactionKind as Kind } from "../../src/modules/wagering/domain/wager-transaction-kind";
import { WagerTransactionStatus as Status } from "../../src/modules/wagering/domain/wager-transaction-status";
import type { Wallet } from "../../src/modules/wallet/domain/wallet";
import { assertLedgerInvariant } from "../support/assertLedgerInvariant";
import { deadlocksOf } from "../support/concurrency";
import { openWalletWithOpening } from "../support/domain-builders";
import { eventually } from "../support/eventually";
import { uniqueId } from "../support/ids";
import { createWorkerRig } from "../support/pending-env";
import { createPersistence, type Persistence } from "../support/persistence";
import { connect } from "../support/sql";
import {
	bet,
	createSubmitHarness,
	SteppingClock,
	SUBMIT_CONTEXT,
	type SubmitHarness,
} from "../support/submit-harness";
import {
	createSuiteDatabase,
	type SuiteDatabase,
} from "../support/suite-database";

/** Follows the wall clock, so workers and arrivals race for real. */
class LiveClock extends SteppingClock {
	override now(): Date {
		return new Date();
	}
}

/** Tiny delays and a huge attempt budget: the references of this suite always do arrive. */
const LIVE_BACKOFF: ReferenceBackoffConfig = {
	maxAttempts: 500,
	baseMs: 5,
	factor: 2,
	capMs: 20,
};

class Barrier {
	private arrived = 0;
	private release: () => void = () => {};
	private readonly opened = new Promise<void>((resolve) => {
		this.release = resolve;
	});
	constructor(private readonly parties: number) {}
	async wait(): Promise<void> {
		this.arrived += 1;
		if (this.arrived >= this.parties) this.release();
		await this.opened;
	}
}

/** Holds a worker, once its candidates are read, until every party has read its own. */
function holdAfterRead(barrier: Barrier) {
	return (real: WagerTransactionRepository): WagerTransactionRepository =>
		new Proxy(real, {
			get(target, property) {
				if (property === "findDuePendingReferences") {
					return async (
						...args: Parameters<typeof target.findDuePendingReferences>
					) => {
						const candidates = await target.findDuePendingReferences(...args);
						await barrier.wait();
						return candidates;
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
}

let db: SuiteDatabase;
let sql: Client;
const pools: Persistence[] = [];

async function pool(): Promise<Persistence> {
	const p = await createPersistence(db.url, { poolMax: 8 });
	pools.push(p);
	return p;
}

beforeAll(async () => {
	db = await createSuiteDatabase();
	sql = await connect(db.url);
});

afterAll(async () => {
	await Promise.all(pools.map((p) => p.close()));
	await sql.end();
	await db.drop();
});

const ext = (label: string) => `${label}-${uniqueId()}`;

function send(
	h: SubmitHarness,
	wallet: Wallet,
	kind: Kind,
	externalId: string,
	reference?: string,
) {
	return h.submit.execute(
		bet(wallet.id, wallet.playerId, {
			kind,
			externalTransactionId: externalId,
			idempotencyKey: `provider-a:${externalId}`,
			money: { amount: "25.00", currency: "BRL" },
			referenceExternalTransactionId: reference,
		}),
		SUBMIT_CONTEXT,
	);
}

const pendingCount = async (): Promise<number> =>
	(
		await sql.query(
			"select count(*)::int as n from wager_transactions where status = 'PENDING_REFERENCE'",
		)
	).rows[0].n as number;

describe("TST-C-07 pending-reference workers (real PostgreSQL)", () => {
	test("TST-C-07 REFUND/ROLLBACK delivered before their references, two active workers, repeated: each is processed exactly once", async () => {
		const ROUNDS = 5;
		const WALLETS = 6;
		const business = await pool();
		const clock = new LiveClock();
		const h = createSubmitHarness(business, { clock, backoff: LIVE_BACKOFF });
		const rigs = await Promise.all(
			[0, 1].map(async () =>
				createWorkerRig(await pool(), {
					clock,
					backoff: LIVE_BACKOFF,
					concurrency: 4,
				}),
			),
		);

		let running = true;
		const totals = { processed: 0, errors: 0 };
		const loops = rigs.map(async ({ worker }) => {
			while (running) {
				const pass = await worker.runOnce();
				totals.processed += pass.processed;
				totals.errors += pass.errors;
				// Yield to the event loop between passes (a pass with no candidates does no I/O).
				await new Promise((resolve) => setImmediate(resolve));
			}
		});

		const wallets: Wallet[] = [];
		try {
			for (let round = 0; round < ROUNDS; round++) {
				const roundWallets = await Promise.all(
					Array.from({ length: WALLETS }, () =>
						openWalletWithOpening(business, "100.00"),
					),
				);
				wallets.push(...roundWallets);
				await Promise.all(
					roundWallets.map(async (wallet) => {
						const betA = ext("bet-a");
						const betB = ext("bet-b");
						// The dependents come first: the references are not there yet.
						const refund = await send(
							h,
							wallet,
							Kind.Refund,
							ext("refund"),
							betA,
						);
						const rollback = await send(
							h,
							wallet,
							Kind.Rollback,
							ext("rollback"),
							betB,
						);
						expect(refund.status).toBe(Status.PendingReference);
						expect(rollback.status).toBe(Status.PendingReference);
						// ...and the references arrive while the workers are polling.
						await Promise.all([
							send(h, wallet, Kind.Bet, betA),
							send(h, wallet, Kind.Bet, betB),
						]);
					}),
				);
			}

			await eventually(async () => (await pendingCount()) === 0, {
				timeout: 30_000,
				interval: 100,
			});
		} finally {
			running = false;
			await Promise.all(loops);
		}

		expect(totals).toEqual({ processed: ROUNDS * WALLETS * 2, errors: 0 });
		for (const wallet of wallets) {
			const row = (
				await sql.query("select balance, version from wallets where id = $1", [
					wallet.id,
				])
			).rows[0];
			// 100.00 - 25 - 25 (two BETs) + 25 + 25 (REFUND credit, ROLLBACK of a BET credit).
			expect(row).toEqual({ balance: "100.00", version: 5 });
			const perTransaction = await sql.query(
				"select transaction_id, count(*)::int as n from wallet_ledger_entries where wallet_id = $1 group by transaction_id",
				[wallet.id],
			);
			expect(perTransaction.rows).toHaveLength(5);
			expect(perTransaction.rows.every((r) => r.n === 1)).toBe(true);
			await assertLedgerInvariant(business.ledgerIntegrity, wallet.id);
		}
	}, 60_000);

	test("TST-C-07 two workers contending for the same candidates: one effect each, the loser revalidates and skips", async () => {
		const business = await pool();
		const clock = new SteppingClock();
		const h = createSubmitHarness(business, { clock });
		const wallet = await openWalletWithOpening(business, "200.00");
		const betIds = [0, 1, 2, 3].map((i) => ext(`bet-${i}`));
		const refunds = [];
		for (const betId of betIds) {
			refunds.push(await send(h, wallet, Kind.Refund, ext("refund"), betId));
		}
		for (const betId of betIds) await send(h, wallet, Kind.Bet, betId);
		// All four are woken (due now); both workers will read all four before either acts.
		const barrier = new Barrier(2);
		const rigs = await Promise.all(
			[0, 1].map(async () =>
				createWorkerRig(await pool(), {
					clock,
					wrapTransactions: holdAfterRead(barrier),
				}),
			),
		);

		const passes = await Promise.all(rigs.map((rig) => rig.worker.runOnce()));

		expect(passes.map((pass) => pass.candidates)).toEqual([4, 4]);
		expect(passes.reduce((sum, pass) => sum + pass.processed, 0)).toBe(4);
		expect(passes.reduce((sum, pass) => sum + pass.skipped, 0)).toBe(4);
		expect(passes.reduce((sum, pass) => sum + pass.errors, 0)).toBe(0);
		for (const rig of rigs) {
			expect(rig.logger.lines.filter((line) => line.level === "error")).toEqual(
				[],
			);
		}
		for (const refund of refunds) {
			const entries = await sql.query(
				"select count(*)::int as n from wallet_ledger_entries where transaction_id = $1",
				[refund.transactionId],
			);
			expect(entries.rows[0].n).toBe(1);
		}
		expect(
			(
				await sql.query("select balance, version from wallets where id = $1", [
					wallet.id,
				])
			).rows[0],
		).toEqual({ balance: "200.00", version: 9 });
		await assertLedgerInvariant(business.ledgerIntegrity, wallet.id);
	});

	test("TST-C-07 two workers on a still-missing reference count one attempt: the loser finds it rescheduled and skips", async () => {
		const business = await pool();
		const clock = new SteppingClock();
		const h = createSubmitHarness(business, { clock });
		const wallet = await openWalletWithOpening(business, "100.00");
		const refund = await send(
			h,
			wallet,
			Kind.Refund,
			ext("refund"),
			ext("never"),
		);
		clock.advance(5000);
		const barrier = new Barrier(2);
		const rigs = await Promise.all(
			[0, 1].map(async () =>
				createWorkerRig(await pool(), {
					clock,
					wrapTransactions: holdAfterRead(barrier),
				}),
			),
		);

		const passes = await Promise.all(rigs.map((rig) => rig.worker.runOnce()));

		expect(passes.map((pass) => pass.candidates)).toEqual([1, 1]);
		expect(passes.reduce((sum, pass) => sum + pass.rescheduled, 0)).toBe(1);
		expect(passes.reduce((sum, pass) => sum + pass.skipped, 0)).toBe(1);
		const row = (
			await sql.query(
				"select reference_attempts, status from wager_transactions where id = $1",
				[refund.transactionId],
			)
		).rows[0];
		expect(row).toEqual({
			reference_attempts: 1,
			status: Status.PendingReference,
		});
	});

	test("TST-C-07 the worker takes the wallet lock before the row: no deadlock against a reference arriving on the same wallet", async () => {
		const arriving = await pool();
		const clock = new SteppingClock();
		const h = createSubmitHarness(arriving, { clock });
		const wallet = await openWalletWithOpening(arriving, "100.00");
		const missing = ext("never-arrives");
		await send(h, wallet, Kind.Refund, ext("refund"), missing);
		clock.advance(5000);
		const rig = createWorkerRig(await pool(), { clock });
		const deadlocksBefore = await deadlocksOf(sql);

		let holding: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			holding = resolve;
		});
		// The arriving side of ADR-0007: wallet lock first, then it updates the pending row.
		const arrival = arriving.tm.run(async () => {
			await arriving.wallets.findByIdForUpdate(wallet.id);
			holding();
			await eventually(async () => {
				const waiting = await sql.query(
					"select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
				);
				return waiting.rows[0].n >= 1;
			});
			await arriving.transactions.wakeDependents(
				"provider-a",
				missing,
				wallet.id,
				clock.now(),
			);
		});
		await held;
		const [, pass] = await Promise.all([arrival, rig.worker.runOnce()]);

		// With the row taken first, the worker and the arrival would wait for each other (40P01).
		expect(pass).toMatchObject({ candidates: 1, rescheduled: 1, errors: 0 });
		expect(await deadlocksOf(sql)).toBe(deadlocksBefore);
		await assertLedgerInvariant(arriving.ledgerIntegrity, wallet.id);
	});
});
