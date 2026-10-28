import { describe, expect, test } from "bun:test";
import { WagerTransactionFailed } from "../../../src/modules/messaging/domain/events/wager-transaction-failed";
import { WagerTransactionPendingReference } from "../../../src/modules/messaging/domain/events/wager-transaction-pending-reference";
import { WagerTransactionProcessed } from "../../../src/modules/messaging/domain/events/wager-transaction-processed";
import { WagerTransactionRejected } from "../../../src/modules/messaging/domain/events/wager-transaction-rejected";
import { WalletBalanceChanged } from "../../../src/modules/messaging/domain/events/wallet-balance-changed";
import { IntegrationEvent } from "../../../src/modules/messaging/domain/integration-event";
import { DomainError } from "../../../src/shared/errors";
import { Money } from "../../../src/shared/money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const occurredAt = new Date("2026-10-27T10:00:00.000Z");
const next = new Date("2026-10-27T10:00:05.000Z");
const ctx = { eventId: "evt-1", correlationId: "corr-1", occurredAt };

const tx = (overrides: Record<string, unknown> = {}) => ({
	id: "tx-1",
	providerId: "prov",
	externalTransactionId: "ext-1",
	walletId: "wallet-1",
	roundId: "round-1",
	gameId: "game-1",
	kind: "BET",
	money: brl("25.00"),
	referenceTransactionId: undefined as string | undefined,
	failureCode: undefined as string | undefined,
	processedAt: undefined as Date | undefined,
	nextAttemptAt: undefined as Date | undefined,
	...overrides,
});

const entry = {
	walletId: "wallet-1",
	transactionId: "tx-1",
	direction: "DEBIT",
	money: brl("80.00"),
	balanceBefore: brl("100.00"),
	balanceAfter: brl("20.00"),
	walletVersion: 2,
};

describe("TST-U-09 integration events", () => {
	test("TST-U-09 WagerTransactionProcessed envelope and data", () => {
		const event = WagerTransactionProcessed.from(
			tx({ processedAt: next, referenceTransactionId: "tx-0" }),
			ctx,
		);
		expect(event).toBeInstanceOf(IntegrationEvent);
		expect(event.eventType).toBe("WagerTransactionProcessed");
		expect(event.version).toBe(1);
		expect(event.toJSON()).toEqual({
			eventId: "evt-1",
			eventType: "WagerTransactionProcessed",
			aggregateId: "tx-1",
			correlationId: "corr-1",
			causationId: "tx-1",
			occurredAt: "2026-10-27T10:00:00.000Z",
			version: 1,
			data: {
				transactionId: "tx-1",
				providerId: "prov",
				externalTransactionId: "ext-1",
				walletId: "wallet-1",
				roundId: "round-1",
				gameId: "game-1",
				kind: "BET",
				money: { amount: "25.00", currency: "BRL" },
				referenceTransactionId: "tx-0",
				processedAt: "2026-10-27T10:00:05.000Z",
			},
		});
	});

	test("TST-U-09 WagerTransactionRejected carries the failure code", () => {
		const json = WagerTransactionRejected.from(
			tx({ failureCode: "INSUFFICIENT_FUNDS" }),
			ctx,
		).toJSON();
		expect(json.eventType).toBe("WagerTransactionRejected");
		expect(json.aggregateId).toBe("tx-1");
		expect(json.causationId).toBe("tx-1");
		expect(json.data).toMatchObject({
			transactionId: "tx-1",
			failureCode: "INSUFFICIENT_FUNDS",
			money: { amount: "25.00", currency: "BRL" },
		});
	});

	test("TST-U-09 WagerTransactionPendingReference carries nextAttemptAt as ISO", () => {
		const json = WagerTransactionPendingReference.from(
			tx({ kind: "REFUND", nextAttemptAt: next }),
			ctx,
		).toJSON();
		expect(json.eventType).toBe("WagerTransactionPendingReference");
		expect(json.data).toMatchObject({
			kind: "REFUND",
			nextAttemptAt: "2026-10-27T10:00:05.000Z",
		});
	});

	test("TST-U-09 WagerTransactionFailed carries the failure code", () => {
		const json = WagerTransactionFailed.from(
			tx({ failureCode: "PROCESSING_ATTEMPTS_EXHAUSTED" }),
			ctx,
		).toJSON();
		expect(json.eventType).toBe("WagerTransactionFailed");
		expect(json.data).toMatchObject({
			failureCode: "PROCESSING_ATTEMPTS_EXHAUSTED",
		});
	});

	test("TST-U-09 WalletBalanceChanged is aggregated by wallet and caused by the transaction", () => {
		const event = WalletBalanceChanged.from(entry, ctx);
		expect(event.eventType).toBe("WalletBalanceChanged");
		expect(event.version).toBe(1);
		expect(event.toJSON()).toEqual({
			eventId: "evt-1",
			eventType: "WalletBalanceChanged",
			aggregateId: "wallet-1",
			correlationId: "corr-1",
			causationId: "tx-1",
			occurredAt: "2026-10-27T10:00:00.000Z",
			version: 1,
			data: {
				walletId: "wallet-1",
				transactionId: "tx-1",
				direction: "DEBIT",
				money: { amount: "80.00", currency: "BRL" },
				balanceBefore: { amount: "100.00", currency: "BRL" },
				balanceAfter: { amount: "20.00", currency: "BRL" },
				walletVersion: 2,
			},
		});
	});

	test("TST-U-09 money is always a plain string DTO, never a Money instance", () => {
		const events = [
			WagerTransactionProcessed.from(tx({ processedAt: next }), ctx),
			WagerTransactionRejected.from(tx({ failureCode: "X" }), ctx),
			WagerTransactionPendingReference.from(tx({ nextAttemptAt: next }), ctx),
			WagerTransactionFailed.from(tx({ failureCode: "X" }), ctx),
			WalletBalanceChanged.from(entry, ctx),
		];
		for (const event of events) {
			const text = JSON.stringify(event.toJSON());
			expect(text).not.toContain("value");
			const roundTrip = JSON.parse(text) as { data: Record<string, unknown> };
			for (const key of ["money", "balanceBefore", "balanceAfter"]) {
				const field = roundTrip.data[key];
				if (field !== undefined) {
					expect(Object.keys(field as object).sort()).toEqual([
						"amount",
						"currency",
					]);
					expect(typeof (field as { amount: unknown }).amount).toBe("string");
				}
			}
			expect(JSON.stringify(event.toJSON().data)).toBe(
				JSON.stringify(JSON.parse(text).data),
			);
		}
	});

	test("TST-U-09 occurredAt is ISO-8601 in the envelope and a Date on the instance", () => {
		const event = WalletBalanceChanged.from(entry, ctx);
		expect(event.occurredAt).toEqual(occurredAt);
		expect(event.toJSON().occurredAt).toBe(occurredAt.toISOString());
	});

	test("TST-U-09 optional fields are omitted from the JSON, not serialized as null", () => {
		const json = WagerTransactionProcessed.from(
			tx({ processedAt: next }),
			ctx,
		).toJSON();
		expect(Object.hasOwn(json.data, "referenceTransactionId")).toBe(false);
		expect(Object.hasOwn(json.data, "failureCode")).toBe(false);
	});

	test("TST-U-09 each event type has a distinct eventType and version 1", () => {
		const events = [
			WagerTransactionProcessed.from(tx({ processedAt: next }), ctx),
			WagerTransactionRejected.from(tx({ failureCode: "X" }), ctx),
			WagerTransactionPendingReference.from(tx({ nextAttemptAt: next }), ctx),
			WagerTransactionFailed.from(tx({ failureCode: "X" }), ctx),
			WalletBalanceChanged.from(entry, ctx),
		];
		expect(new Set(events.map((e) => e.eventType)).size).toBe(5);
		expect(events.every((e) => e.version === 1)).toBe(true);
	});

	test("TST-U-09 factories refuse a transaction missing the outcome field", () => {
		expect(() => WagerTransactionProcessed.from(tx(), ctx)).toThrow(
			DomainError,
		);
		expect(() => WagerTransactionRejected.from(tx(), ctx)).toThrow(DomainError);
		expect(() => WagerTransactionFailed.from(tx(), ctx)).toThrow(DomainError);
		expect(() => WagerTransactionPendingReference.from(tx(), ctx)).toThrow(
			DomainError,
		);
	});

	test("TST-U-09 data is read-only after construction", () => {
		const event = WalletBalanceChanged.from(entry, ctx);
		expect(Object.isFrozen(event.data)).toBe(true);
	});
});
