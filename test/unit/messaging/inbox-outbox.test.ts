import { describe, expect, test } from "bun:test";
import { WalletBalanceChanged } from "../../../src/modules/messaging/domain/events/wallet-balance-changed";
import { InboxMessage } from "../../../src/modules/messaging/domain/inbox-message";
import { OutboxMessage } from "../../../src/modules/messaging/domain/outbox-message";
import { DomainError } from "../../../src/shared/errors";
import { Money } from "../../../src/shared/money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const t0 = new Date("2026-10-27T10:00:00.000Z");
const plus = (base: Date, ms: number) => new Date(base.getTime() + ms);

const event = () =>
	WalletBalanceChanged.from(
		{
			walletId: "wallet-1",
			transactionId: "tx-1",
			direction: "DEBIT",
			money: brl("80.00"),
			balanceBefore: brl("100.00"),
			balanceAfter: brl("20.00"),
			walletVersion: 2,
		},
		{ eventId: "evt-1", correlationId: "corr-1", occurredAt: t0 },
	);

const outbox = () => OutboxMessage.enqueue(event(), "wallet-1");

/** Delay (ms) scheduled by the n-th consecutive retry, starting from a fresh message. */
function delaysOf(retries: number): number[] {
	const message = outbox();
	const delays: number[] = [];
	for (let i = 0; i < retries; i += 1) {
		message.scheduleRetry(t0);
		delays.push((message.nextAttemptAt as Date).getTime() - t0.getTime());
	}
	return delays;
}

describe("TST-U-08 OutboxMessage", () => {
	test("TST-U-08 enqueue copies the envelope: id = eventId, group key, serialized payload", () => {
		const message = outbox();
		expect(message.id).toBe("evt-1");
		expect(message.aggregateId).toBe("wallet-1");
		expect(message.groupKey).toBe("wallet-1");
		expect(message.eventType).toBe("WalletBalanceChanged");
		expect(message.occurredAt).toEqual(t0);
		expect(message.payload).toEqual({ ...event().toJSON() });
		expect(message.attempts).toBe(0);
		expect(message.nextAttemptAt).toEqual(t0);
		expect(message.publishedAt).toBeUndefined();
		expect(message.failedAt).toBeUndefined();
		expect(message.lastError).toBeUndefined();
	});

	test("TST-U-08 a new message is pending and due at occurredAt, not before", () => {
		const message = outbox();
		expect(message.isPending()).toBe(true);
		expect(message.isDue(plus(t0, -1))).toBe(false);
		expect(message.isDue(t0)).toBe(true);
		expect(message.isDue(plus(t0, 1))).toBe(true);
	});

	test("TST-U-08 scheduleRetry follows 1s, 2s, 4s ... capped at 60s", () => {
		expect(delaysOf(9)).toEqual([
			1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
		]);
	});

	test("TST-U-08 the cap holds for a very large number of attempts and there is no attempt limit", () => {
		const message = outbox();
		for (let i = 0; i < 2000; i += 1) {
			message.scheduleRetry(t0);
		}
		expect(message.attempts).toBe(2000);
		expect((message.nextAttemptAt as Date).getTime() - t0.getTime()).toBe(
			60000,
		);
		expect(message.isPending()).toBe(true);
	});

	test("TST-U-08 scheduleRetry counts the attempt and reschedules from now", () => {
		const message = outbox();
		const now = plus(t0, 5000);
		message.scheduleRetry(now);
		expect(message.attempts).toBe(1);
		expect(message.nextAttemptAt).toEqual(plus(now, 1000));
		expect(message.isDue(plus(now, 999))).toBe(false);
		expect(message.isDue(plus(now, 1000))).toBe(true);
	});

	test("TST-U-08 backoff base and cap are configurable", () => {
		const message = outbox();
		message.scheduleRetry(t0, { baseMs: 10, capMs: 25 });
		expect((message.nextAttemptAt as Date).getTime() - t0.getTime()).toBe(10);
		message.scheduleRetry(t0, { baseMs: 10, capMs: 25 });
		expect((message.nextAttemptAt as Date).getTime() - t0.getTime()).toBe(20);
		message.scheduleRetry(t0, { baseMs: 10, capMs: 25 });
		expect((message.nextAttemptAt as Date).getTime() - t0.getTime()).toBe(25);
	});

	test("TST-U-08 markPublished ends the lifecycle", () => {
		const message = outbox();
		const at = plus(t0, 3000);
		message.markPublished(at);
		expect(message.publishedAt).toEqual(at);
		expect(message.isPending()).toBe(false);
		expect(message.isDue(plus(at, 999999))).toBe(false);
	});

	test("TST-U-08 markFailed records the permanent error and stops retries", () => {
		const message = outbox();
		const at = plus(t0, 3000);
		message.markFailed(at, "MessageTooLong");
		expect(message.failedAt).toEqual(at);
		expect(message.lastError).toBe("MessageTooLong");
		expect(message.isPending()).toBe(false);
		expect(message.isDue(plus(at, 999999))).toBe(false);
		expect(message.publishedAt).toBeUndefined();
	});

	test("TST-U-08 a finished message cannot be published, failed or retried again", () => {
		const published = outbox();
		published.markPublished(t0);
		const failed = outbox();
		failed.markFailed(t0, "x");
		for (const message of [published, failed]) {
			expect(() => message.markPublished(t0)).toThrow(DomainError);
			expect(() => message.markFailed(t0, "y")).toThrow(DomainError);
			expect(() => message.scheduleRetry(t0)).toThrow(DomainError);
		}
	});

	test("TST-U-08 rehydrate rebuilds persisted state, keeping the stable eventId", () => {
		const message = OutboxMessage.rehydrate({
			id: "evt-9",
			aggregateId: "agg",
			groupKey: "wallet-9",
			eventType: "WalletBalanceChanged",
			payload: { a: 1 },
			occurredAt: t0,
			attempts: 4,
			nextAttemptAt: plus(t0, 8000),
			publishedAt: undefined,
			failedAt: undefined,
			lastError: undefined,
		});
		expect(message.id).toBe("evt-9");
		expect(message.attempts).toBe(4);
		expect(message.isDue(plus(t0, 7999))).toBe(false);
		expect(message.isDue(plus(t0, 8000))).toBe(true);
		message.scheduleRetry(plus(t0, 8000));
		expect(message.attempts).toBe(5);
		expect((message.nextAttemptAt as Date).getTime()).toBe(
			plus(t0, 8000 + 16000).getTime(),
		);
	});
});

describe("TST-U-08 InboxMessage", () => {
	const receive = () =>
		InboxMessage.receive({
			messageId: "msg-1",
			consumerName: "wager-transactions",
			payloadHash: "hash",
			now: t0,
		});

	test("TST-U-08 receive creates an unprocessed message", () => {
		const message = receive();
		expect(message.messageId).toBe("msg-1");
		expect(message.consumerName).toBe("wager-transactions");
		expect(message.payloadHash).toBe("hash");
		expect(message.receivedAt).toEqual(t0);
		expect(message.processedAt).toBeUndefined();
		expect(message.isProcessed()).toBe(false);
	});

	test("TST-U-08 markProcessed records when", () => {
		const message = receive();
		const at = plus(t0, 10);
		message.markProcessed(at);
		expect(message.isProcessed()).toBe(true);
		expect(message.processedAt).toEqual(at);
	});

	test("TST-U-08 processing twice is an error", () => {
		const message = receive();
		message.markProcessed(t0);
		expect(() => message.markProcessed(plus(t0, 1))).toThrow(DomainError);
		expect(message.processedAt).toEqual(t0);
	});

	test("TST-U-08 rehydrate restores a processed message", () => {
		const message = InboxMessage.rehydrate({
			messageId: "m",
			consumerName: "c",
			payloadHash: "h",
			receivedAt: t0,
			processedAt: plus(t0, 5),
		});
		expect(message.isProcessed()).toBe(true);
	});
});
