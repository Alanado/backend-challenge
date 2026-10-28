import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { InboxMessage } from "../../src/modules/messaging/domain/inbox-message";
import { OutboxMessage } from "../../src/modules/messaging/domain/outbox-message";
import { TransactionRequiredError } from "../../src/modules/platform/application/persistence-errors";
import { FailureCode } from "../../src/modules/wagering/domain/failure-code";
import { WagerTransactionKind } from "../../src/modules/wagering/domain/wager-transaction-kind";
import { WagerTransactionStatus } from "../../src/modules/wagering/domain/wager-transaction-status";
import { WalletAlreadyExistsError } from "../../src/modules/wallet/application/errors";
import { VersionAssertionError } from "../../src/modules/wallet/application/wallet-repository";
import { LedgerDirection } from "../../src/modules/wallet/domain/wallet-ledger-entry";
import { assertCreatedWalletsConsistent } from "../support/assertLedgerInvariant";
import {
	brl,
	newTransaction,
	newWallet,
	openWalletWithOpening,
} from "../support/domain-builders";
import { uniqueId } from "../support/ids";
import { createPersistence, type Persistence } from "../support/persistence";
import { connect, failureOf } from "../support/sql";
import {
	createSuiteDatabase,
	type SuiteDatabase,
} from "../support/suite-database";

let db: SuiteDatabase;
let p: Persistence;
let sql: Client;

beforeAll(async () => {
	db = await createSuiteDatabase();
	p = await createPersistence(db.url);
	sql = await connect(db.url);
});

afterAll(async () => {
	await sql.end();
	await p.close();
	await db.drop();
});

const at = (iso: string) => new Date(iso);

async function rowOf(table: string, key: string, id: string) {
	const res = await sql.query(`select * from ${table} where ${key} = $1`, [id]);
	return res.rows[0] as Record<string, unknown> | undefined;
}

describe("X-10 wallet repository round trip (PostgreSQL real)", () => {
	test.each(["12345678901234567.89", "0.01", "100.00"])(
		"X-10 balance %s survives domain -> row -> domain as a string",
		async (amount) => {
			const now = at("2026-10-28T10:00:00.123Z");
			const wallet = await openWalletWithOpening(p, amount, now);

			const loaded = await p.wallets.findById(wallet.id);

			expect(loaded).toBeDefined();
			expect(loaded?.balance.toString()).toBe(amount);
			expect(loaded?.currency).toBe("BRL");
			expect(loaded?.playerId).toBe(wallet.playerId);
			expect(loaded?.version).toBe(1);
			expect(loaded?.createdAt.toISOString()).toBe("2026-10-28T10:00:00.123Z");
			expect(loaded?.updatedAt.toISOString()).toBe("2026-10-28T10:00:00.123Z");
			const stored = await rowOf("wallets", "id", wallet.id);
			expect(stored?.balance).toBe(amount);
		},
	);

	test("X-10 findByPlayerAndCurrency finds by the unique pair and misses otherwise", async () => {
		const wallet = await openWalletWithOpening(p, "5.00");
		expect(
			(await p.wallets.findByPlayerAndCurrency(wallet.playerId, "BRL"))?.id,
		).toBe(wallet.id);
		expect(
			await p.wallets.findByPlayerAndCurrency(wallet.playerId, "USD"),
		).toBeUndefined();
		expect(await p.wallets.findById(uniqueId())).toBeUndefined();
	});

	test("X-10 a second wallet for the same player and currency is refused by the UNIQUE and surfaces as WalletAlreadyExistsError (T-030)", async () => {
		const wallet = await openWalletWithOpening(p, "5.00");
		const twin = newWallet("1.00", new Date(), wallet.playerId);
		await expect(p.wallets.insert(twin)).rejects.toBeInstanceOf(
			WalletAlreadyExistsError,
		);
		// The constraint itself (23505 on wallets_player_currency_uk) is proven straight on SQL in TST-I-02.
		expect(await p.wallets.findById(twin.id)).toBeUndefined();
	});
});

describe("X-11 wallet balance update with the version assertion", () => {
	test("X-11 updateBalance persists balance, version and updatedAt and appends the ledger entry", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const bet = newTransaction({
			walletId: wallet.id,
			playerId: wallet.playerId,
			amount: "30.00",
		});
		const now = at("2026-10-28T11:00:00.000Z");

		await p.tm.run(async () => {
			const locked = await p.wallets.findByIdForUpdate(wallet.id);
			if (!locked) throw new Error("wallet vanished");
			await p.transactions.insertIfAbsent(bet);
			const entry = locked.debit(bet.money, bet.id, now, uniqueId());
			await p.wallets.updateBalance(locked, locked.version - 1);
			await p.ledger.append(entry);
			bet.markProcessed(undefined, now, locked.balance);
			await p.transactions.update(bet, now);
		});

		const reloaded = await p.wallets.findById(wallet.id);
		expect(reloaded?.balance.toString()).toBe("70.00");
		expect(reloaded?.version).toBe(2);
		expect(reloaded?.updatedAt.toISOString()).toBe("2026-10-28T11:00:00.000Z");
		const entries = await p.ledger.findByWallet(wallet.id);
		expect(
			entries.map((e) => [
				e.walletVersion,
				e.direction,
				e.balanceBefore.toString(),
				e.balanceAfter.toString(),
			]),
		).toEqual([
			[1, LedgerDirection.Credit, "0.00", "100.00"],
			[2, LedgerDirection.Debit, "100.00", "70.00"],
		]);
	});

	test("X-11 a stale expected version fails with VersionAssertionError and changes nothing", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const stale = await p.wallets.findById(wallet.id);
		if (!stale) throw new Error("wallet vanished");
		stale.credit(brl("1.00"), uniqueId(), new Date(), uniqueId());

		// The stored row is at version 1; claiming it is at version 7 must not write.
		await expect(p.wallets.updateBalance(stale, 7)).rejects.toBeInstanceOf(
			VersionAssertionError,
		);

		const stored = await p.wallets.findById(wallet.id);
		expect(stored?.balance.toString()).toBe("100.00");
		expect(stored?.version).toBe(1);
	});

	test("X-11 the same update applied twice fails the second time", async () => {
		const wallet = await openWalletWithOpening(p, "100.00");
		const credit = newTransaction({
			walletId: wallet.id,
			playerId: wallet.playerId,
			kind: WagerTransactionKind.Win,
			amount: "1.00",
		});

		const secondAttempt = await p.tm.run(async () => {
			const locked = await p.wallets.findByIdForUpdate(wallet.id);
			if (!locked) throw new Error("wallet vanished");
			await p.transactions.insertIfAbsent(credit);
			const entry = locked.credit(
				credit.money,
				credit.id,
				new Date(),
				uniqueId(),
			);
			await p.wallets.updateBalance(locked, 1);
			await p.ledger.append(entry);
			credit.markProcessed(undefined, new Date(), locked.balance);
			await p.transactions.update(credit, new Date());
			// The guard is a zero-row UPDATE, not a SQL error: the transaction stays usable and commits.
			return p.wallets.updateBalance(locked, 1).then(
				() => undefined,
				(e: unknown) => e,
			);
		});

		expect(secondAttempt).toBeInstanceOf(VersionAssertionError);
		expect((await p.wallets.findById(wallet.id))?.balance.toString()).toBe(
			"101.00",
		);
	});

	test("X-11 findByIdForUpdate outside a transaction is refused", async () => {
		await expect(
			p.wallets.findByIdForUpdate(uniqueId()),
		).rejects.toBeInstanceOf(TransactionRequiredError);
	});
});

describe("X-12 wager transaction repository", () => {
	test("X-12 a PENDING transaction round-trips every field", async () => {
		const wallet = await openWalletWithOpening(p, "50.00");
		const created = at("2026-10-28T12:00:00.456Z");
		const tx = newTransaction({
			walletId: wallet.id,
			playerId: wallet.playerId,
			kind: WagerTransactionKind.Win,
			amount: "12345678901234567.89",
			providerId: "prov-x",
			externalTransactionId: "ext-1",
			idempotencyKey: "idem-1",
			now: created,
		});

		expect(await p.transactions.insertIfAbsent(tx)).toBe(true);
		const loaded = await p.transactions.findById(tx.id);

		expect(loaded?.id).toBe(tx.id);
		expect(loaded?.providerId).toBe("prov-x");
		expect(loaded?.externalTransactionId).toBe("ext-1");
		expect(loaded?.idempotencyKey).toBe("idem-1");
		expect(loaded?.payloadHash).toBe("hash");
		expect(loaded?.walletId).toBe(wallet.id);
		expect(loaded?.playerId).toBe(wallet.playerId);
		expect(loaded?.roundId).toBe("round-1");
		expect(loaded?.gameId).toBe("game-1");
		expect(loaded?.kind).toBe(WagerTransactionKind.Win);
		expect(loaded?.money.toString()).toBe("12345678901234567.89");
		expect(loaded?.money.currency).toBe("BRL");
		expect(loaded?.status).toBe(WagerTransactionStatus.Pending);
		expect(loaded?.createdAt.toISOString()).toBe("2026-10-28T12:00:00.456Z");
		expect(loaded?.referenceExternalTransactionId).toBeUndefined();
		expect(loaded?.referenceTransactionId).toBeUndefined();
		expect(loaded?.failureCode).toBeUndefined();
		expect(loaded?.observedBalance).toBeUndefined();
		expect(loaded?.processedAt).toBeUndefined();
		expect(loaded?.nextAttemptAt).toBeUndefined();
		expect(loaded?.referenceAttempts).toBe(0);
	});

	test("X-12 PENDING_REFERENCE with retry fields round-trips", async () => {
		const wallet = await openWalletWithOpening(p, "50.00");
		const tx = newTransaction({
			walletId: wallet.id,
			playerId: wallet.playerId,
			kind: WagerTransactionKind.Refund,
			referenceExternalTransactionId: "missing-bet",
		});
		await p.transactions.insertIfAbsent(tx);
		tx.markPendingReference(at("2026-10-28T12:05:00.000Z"));
		tx.rescheduleReference(at("2026-10-28T12:10:00.000Z"));
		await p.transactions.update(tx, new Date());

		const loaded = await p.transactions.findById(tx.id);
		expect(loaded?.status).toBe(WagerTransactionStatus.PendingReference);
		expect(loaded?.referenceExternalTransactionId).toBe("missing-bet");
		expect(loaded?.referenceAttempts).toBe(1);
		expect(loaded?.nextAttemptAt?.toISOString()).toBe(
			"2026-10-28T12:10:00.000Z",
		);
	});

	test("X-12 terminal states come back rehydrated, without replaying a transition", async () => {
		const wallet = await openWalletWithOpening(p, "50.00");
		const processedAt = at("2026-10-28T12:20:00.000Z");

		const bet = newTransaction({
			walletId: wallet.id,
			playerId: wallet.playerId,
		});
		await p.transactions.insertIfAbsent(bet);
		bet.markProcessed(undefined, processedAt, brl("40.00"));
		await p.transactions.update(bet, processedAt);

		const refund = newTransaction({
			walletId: wallet.id,
			playerId: wallet.playerId,
			kind: WagerTransactionKind.Refund,
			referenceExternalTransactionId: bet.externalTransactionId,
		});
		await p.transactions.insertIfAbsent(refund);
		refund.markProcessed(bet.id, processedAt, brl("50.00"));
		await p.transactions.update(refund, processedAt);

		const rejected = newTransaction({
			walletId: wallet.id,
			playerId: wallet.playerId,
		});
		await p.transactions.insertIfAbsent(rejected);
		rejected.reject(FailureCode.InsufficientFunds, brl("50.00"));
		await p.transactions.update(rejected, processedAt);

		const failed = newTransaction({
			walletId: wallet.id,
			playerId: wallet.playerId,
		});
		await p.transactions.insertIfAbsent(failed);
		failed.fail(FailureCode.ProcessingAttemptsExhausted);
		await p.transactions.update(failed, processedAt);

		const [b, r, rej, f] = await Promise.all([
			p.transactions.findById(bet.id),
			p.transactions.findById(refund.id),
			p.transactions.findById(rejected.id),
			p.transactions.findById(failed.id),
		]);
		expect(b?.status).toBe(WagerTransactionStatus.Processed);
		expect(b?.isTerminal()).toBe(true);
		expect(b?.processedAt?.toISOString()).toBe("2026-10-28T12:20:00.000Z");
		expect(b?.observedBalance?.toString()).toBe("40.00");
		expect(r?.referenceTransactionId).toBe(bet.id);
		expect(r?.isTerminal()).toBe(true);
		expect(rej?.status).toBe(WagerTransactionStatus.Rejected);
		expect(rej?.failureCode).toBe(FailureCode.InsufficientFunds);
		expect(rej?.observedBalance?.toString()).toBe("50.00");
		expect(rej?.isTerminal()).toBe(true);
		expect(f?.status).toBe(WagerTransactionStatus.Failed);
		expect(f?.failureCode).toBe(FailureCode.ProcessingAttemptsExhausted);
		expect(f?.isTerminal()).toBe(true);
	});

	test("X-12 lookups by idempotency key and by external id are scoped to the provider", async () => {
		const wallet = await openWalletWithOpening(p, "50.00");
		const tx = newTransaction({
			walletId: wallet.id,
			playerId: wallet.playerId,
			providerId: "prov-a",
			externalTransactionId: `ext-${uniqueId()}`,
			idempotencyKey: `idem-${uniqueId()}`,
		});
		await p.transactions.insertIfAbsent(tx);

		expect(
			(await p.transactions.findByIdempotencyKey("prov-a", tx.idempotencyKey))
				?.id,
		).toBe(tx.id);
		expect(
			(
				await p.transactions.findByExternalId(
					"prov-a",
					tx.externalTransactionId,
				)
			)?.id,
		).toBe(tx.id);
		expect(
			await p.transactions.findByIdempotencyKey("prov-b", tx.idempotencyKey),
		).toBeUndefined();
		expect(
			await p.transactions.findByExternalId("prov-b", tx.externalTransactionId),
		).toBeUndefined();
		expect(await p.transactions.findById(uniqueId())).toBeUndefined();
	});

	test("X-12 insertIfAbsent reports a clash on the idempotency key, or on the external id, without raising", async () => {
		const wallet = await openWalletWithOpening(p, "50.00");
		const first = newTransaction({
			walletId: wallet.id,
			playerId: wallet.playerId,
			providerId: "prov-c",
			externalTransactionId: "ext-c",
			idempotencyKey: "idem-c",
		});
		const sameKey = newTransaction({
			walletId: wallet.id,
			playerId: wallet.playerId,
			providerId: "prov-c",
			externalTransactionId: "ext-other",
			idempotencyKey: "idem-c",
		});
		const sameExternal = newTransaction({
			walletId: wallet.id,
			playerId: wallet.playerId,
			providerId: "prov-c",
			externalTransactionId: "ext-c",
			idempotencyKey: "idem-other",
		});
		const otherProvider = newTransaction({
			walletId: wallet.id,
			playerId: wallet.playerId,
			providerId: "prov-d",
			externalTransactionId: "ext-c",
			idempotencyKey: "idem-c",
		});

		expect(await p.transactions.insertIfAbsent(first)).toBe(true);
		expect(await p.transactions.insertIfAbsent(sameKey)).toBe(false);
		expect(await p.transactions.insertIfAbsent(sameExternal)).toBe(false);
		expect(await p.transactions.insertIfAbsent(otherProvider)).toBe(true);
		expect(await p.transactions.findById(sameKey.id)).toBeUndefined();
		expect(await p.transactions.findById(sameExternal.id)).toBeUndefined();
	});

	test("X-12 insertIfAbsent still raises for a foreign key violation (not a conflict)", async () => {
		const orphan = newTransaction({ walletId: uniqueId() });
		const failure = await failureOf(p.transactions.insertIfAbsent(orphan));
		expect(failure.code).toBe("23503");
	});

	test("X-12 findByIdForUpdate needs a transaction and locks the row", async () => {
		const wallet = await openWalletWithOpening(p, "50.00");
		const tx = newTransaction({
			walletId: wallet.id,
			playerId: wallet.playerId,
		});
		await p.transactions.insertIfAbsent(tx);

		await expect(
			p.transactions.findByIdForUpdate(tx.id),
		).rejects.toBeInstanceOf(TransactionRequiredError);
		const locked = await p.tm.run(() =>
			p.transactions.findByIdForUpdate(tx.id),
		);
		expect(locked?.id).toBe(tx.id);
	});

	test("X-12 update on a missing row is an error, not a silent no-op", async () => {
		const ghost = newTransaction({ walletId: uniqueId() });
		await expect(p.transactions.update(ghost, new Date())).rejects.toThrow(
			/not found/,
		);
	});

	test("X-12 existsProcessedReversalOf is true only for a PROCESSED reversal of that transaction", async () => {
		const wallet = await openWalletWithOpening(p, "50.00");
		const bet = newTransaction({
			walletId: wallet.id,
			playerId: wallet.playerId,
		});
		await p.transactions.insertIfAbsent(bet);
		bet.markProcessed(undefined, new Date(), brl("40.00"));
		await p.transactions.update(bet, new Date());
		expect(await p.transactions.existsProcessedReversalOf(bet.id)).toBe(false);

		const pendingRefund = newTransaction({
			walletId: wallet.id,
			playerId: wallet.playerId,
			kind: WagerTransactionKind.Refund,
			referenceExternalTransactionId: bet.externalTransactionId,
		});
		await p.transactions.insertIfAbsent(pendingRefund);
		expect(await p.transactions.existsProcessedReversalOf(bet.id)).toBe(false);

		pendingRefund.markProcessed(bet.id, new Date(), brl("50.00"));
		await p.transactions.update(pendingRefund, new Date());
		expect(await p.transactions.existsProcessedReversalOf(bet.id)).toBe(true);
		expect(await p.transactions.existsProcessedReversalOf(uniqueId())).toBe(
			false,
		);
	});

	test("X-12 wakeDependents wakes only the informed wallet, provider and reference", async () => {
		const walletA = await openWalletWithOpening(p, "50.00");
		const walletB = await openWalletWithOpening(p, "50.00");
		const later = at("2026-10-28T20:00:00.000Z");
		const now = at("2026-10-28T13:00:00.000Z");

		const waiting = async (
			wallet: typeof walletA,
			providerId: string,
			reference: string,
		) => {
			const tx = newTransaction({
				walletId: wallet.id,
				playerId: wallet.playerId,
				kind: WagerTransactionKind.Refund,
				providerId,
				referenceExternalTransactionId: reference,
			});
			await p.transactions.insertIfAbsent(tx);
			tx.markPendingReference(later);
			await p.transactions.update(tx, new Date());
			return tx;
		};
		const onA = await waiting(walletA, "prov-w", "bet-1");
		const onB = await waiting(walletB, "prov-w", "bet-1");
		const otherRef = await waiting(walletA, "prov-w", "bet-2");
		const otherProvider = await waiting(walletA, "prov-z", "bet-1");

		const woken = await p.tm.run(() =>
			p.transactions.wakeDependents("prov-w", "bet-1", walletA.id, now),
		);

		expect(woken).toBe(1);
		const next = async (id: string) =>
			(await p.transactions.findById(id))?.nextAttemptAt?.toISOString();
		expect(await next(onA.id)).toBe(now.toISOString());
		expect(await next(onB.id)).toBe(later.toISOString());
		expect(await next(otherRef.id)).toBe(later.toISOString());
		expect(await next(otherProvider.id)).toBe(later.toISOString());
	});
});

describe("X-13 inbox and outbox repositories", () => {
	test("X-13 tryReceive inserts once; a duplicate returns false and keeps the first row", async () => {
		const messageId = `msg-${uniqueId()}`;
		const first = InboxMessage.receive({
			messageId,
			consumerName: "wagering",
			payloadHash: "h1",
			now: at("2026-10-28T14:00:00.000Z"),
		});
		const duplicate = InboxMessage.receive({
			messageId,
			consumerName: "wagering",
			payloadHash: "h2",
			now: at("2026-10-28T14:00:01.000Z"),
		});
		const otherConsumer = InboxMessage.receive({
			messageId,
			consumerName: "audit",
			payloadHash: "h1",
			now: new Date(),
		});

		expect(await p.inbox.tryReceive(first)).toBe(true);
		expect(await p.inbox.tryReceive(duplicate)).toBe(false);
		expect(await p.inbox.tryReceive(otherConsumer)).toBe(true);

		const stored = await p.inbox.find("wagering", messageId);
		expect(stored?.payloadHash).toBe("h1");
		expect(stored?.receivedAt.toISOString()).toBe("2026-10-28T14:00:00.000Z");
		expect(stored?.isProcessed()).toBe(false);
		expect(await p.inbox.find("wagering", "nope")).toBeUndefined();
	});

	test("X-13 markProcessed persists processedAt and the row comes back processed", async () => {
		const messageId = `msg-${uniqueId()}`;
		const message = InboxMessage.receive({
			messageId,
			consumerName: "wagering",
			payloadHash: "h",
			now: new Date(),
		});
		await p.inbox.tryReceive(message);
		message.markProcessed(at("2026-10-28T14:05:00.000Z"));
		await p.inbox.markProcessed(message);

		const stored = await p.inbox.find("wagering", messageId);
		expect(stored?.isProcessed()).toBe(true);
		expect(stored?.processedAt?.toISOString()).toBe("2026-10-28T14:05:00.000Z");
	});

	test("X-13 outbox enqueue round-trips payload, retry and final states", async () => {
		const pending = OutboxMessage.rehydrate({
			id: uniqueId(),
			aggregateId: "agg-1",
			groupKey: "wallet-1",
			eventType: "WalletBalanceChanged",
			payload: {
				eventId: "e1",
				data: {
					balance: { amount: "12345678901234567.89", currency: "BRL" },
					list: [1, "a", null],
				},
			},
			occurredAt: at("2026-10-28T15:00:00.000Z"),
			attempts: 3,
			nextAttemptAt: at("2026-10-28T15:00:08.000Z"),
			publishedAt: undefined,
			failedAt: undefined,
			lastError: undefined,
		});
		const published = OutboxMessage.rehydrate({
			id: uniqueId(),
			aggregateId: "agg-2",
			groupKey: "wallet-2",
			eventType: "WagerTransactionProcessed",
			payload: { eventId: "e2" },
			occurredAt: at("2026-10-28T15:01:00.000Z"),
			attempts: 1,
			nextAttemptAt: at("2026-10-28T15:01:01.000Z"),
			publishedAt: at("2026-10-28T15:01:02.000Z"),
			failedAt: undefined,
			lastError: undefined,
		});
		const failed = OutboxMessage.rehydrate({
			id: uniqueId(),
			aggregateId: "agg-3",
			groupKey: "wallet-3",
			eventType: "WagerTransactionFailed",
			payload: { eventId: "e3" },
			occurredAt: at("2026-10-28T15:02:00.000Z"),
			attempts: 9,
			nextAttemptAt: at("2026-10-28T15:03:00.000Z"),
			publishedAt: undefined,
			failedAt: at("2026-10-28T15:02:30.000Z"),
			lastError: "InvalidParameterValue",
		});

		for (const message of [pending, published, failed])
			await p.outbox.enqueue(message);

		const [a, b, c] = await Promise.all([
			p.outbox.findById(pending.id),
			p.outbox.findById(published.id),
			p.outbox.findById(failed.id),
		]);
		expect(a?.payload).toEqual(pending.payload);
		expect(a?.groupKey).toBe("wallet-1");
		expect(a?.attempts).toBe(3);
		expect(a?.nextAttemptAt.toISOString()).toBe("2026-10-28T15:00:08.000Z");
		expect(a?.isPending()).toBe(true);
		expect(b?.publishedAt?.toISOString()).toBe("2026-10-28T15:01:02.000Z");
		expect(b?.isPending()).toBe(false);
		expect(c?.failedAt?.toISOString()).toBe("2026-10-28T15:02:30.000Z");
		expect(c?.lastError).toBe("InvalidParameterValue");
		expect(await p.outbox.findById(uniqueId())).toBeUndefined();
	});

	test("X-13 an enqueue inside a rolled back transaction leaves nothing behind", async () => {
		const message = OutboxMessage.rehydrate({
			id: uniqueId(),
			aggregateId: "a",
			groupKey: "g",
			eventType: "T",
			payload: { k: 1 },
			occurredAt: new Date(),
			attempts: 0,
			nextAttemptAt: new Date(),
			publishedAt: undefined,
			failedAt: undefined,
			lastError: undefined,
		});
		await expect(
			p.tm.run(async () => {
				await p.outbox.enqueue(message);
				throw new Error("business failure after enqueue");
			}),
		).rejects.toThrow("business failure");
		expect(await p.outbox.findById(message.id)).toBeUndefined();
	});
});

describe("TST-I-14 invariant over what this suite created", () => {
	test("TST-I-14 every wallet created through the repositories still satisfies the ledger invariant", async () => {
		expect(p.created.length).toBeGreaterThan(10);
		await assertCreatedWalletsConsistent(p.ledgerIntegrity, p.created);
	});
});
