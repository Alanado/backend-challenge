import { describe, expect, test } from "bun:test";
import { FailureCode } from "../../../src/modules/wagering/domain/failure-code";
import { WagerTransaction } from "../../../src/modules/wagering/domain/wager-transaction";
import { WagerTransactionKind as Kind } from "../../../src/modules/wagering/domain/wager-transaction-kind";
import { WagerTransactionStatus as Status } from "../../../src/modules/wagering/domain/wager-transaction-status";
import { LedgerDirection } from "../../../src/modules/wallet/domain/wallet-ledger-entry";
import {
	DomainError,
	InvalidReferenceRequirementError,
	InvalidTransactionStateError,
	LedgerDirectionUnavailableError,
} from "../../../src/shared/errors";
import { Money } from "../../../src/shared/money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const t0 = new Date("2026-10-27T10:00:00.000Z");
const t1 = new Date("2026-10-27T10:00:05.000Z");
const t2 = new Date("2026-10-27T10:00:10.000Z");

const create = (kind: Kind, referenceExternalTransactionId?: string) =>
	WagerTransaction.create({
		id: "tx-1",
		providerId: "prov",
		externalTransactionId: "ext-1",
		idempotencyKey: "prov:ext-1",
		payloadHash: "hash-1",
		walletId: "wallet-1",
		playerId: "player-1",
		roundId: "round-1",
		gameId: "game-1",
		kind,
		money: brl("25.00"),
		referenceExternalTransactionId,
		now: t0,
	});

const inStatus = (status: Status, kind: Kind = Kind.Bet) =>
	WagerTransaction.rehydrate({
		id: "tx-1",
		providerId: "prov",
		externalTransactionId: "ext-1",
		idempotencyKey: "prov:ext-1",
		payloadHash: "hash-1",
		walletId: "wallet-1",
		playerId: "player-1",
		roundId: "round-1",
		gameId: "game-1",
		kind,
		money: brl("25.00"),
		referenceExternalTransactionId: undefined,
		createdAt: t0,
		status,
		referenceTransactionId: undefined,
		failureCode:
			status === Status.Rejected || status === Status.Failed
				? FailureCode.InsufficientFunds
				: undefined,
		processedAt: status === Status.Processed ? t1 : undefined,
		observedBalance: undefined,
		referenceAttempts: 0,
		nextAttemptAt: status === Status.PendingReference ? t1 : undefined,
	});

type Operation = {
	name: string;
	run: (tx: WagerTransaction) => void;
	allowedFrom: Status[];
	result: Status;
};

const operations: Operation[] = [
	{
		name: "markProcessed",
		run: (tx) => tx.markProcessed(undefined, t2, brl("10.00")),
		allowedFrom: [Status.Pending, Status.PendingReference],
		result: Status.Processed,
	},
	{
		name: "reject",
		run: (tx) => tx.reject(FailureCode.InsufficientFunds),
		allowedFrom: [Status.Pending, Status.PendingReference],
		result: Status.Rejected,
	},
	{
		name: "fail",
		run: (tx) => tx.fail(FailureCode.ProcessingAttemptsExhausted),
		allowedFrom: [Status.Pending, Status.PendingReference],
		result: Status.Failed,
	},
	{
		name: "markPendingReference",
		run: (tx) => tx.markPendingReference(t2),
		allowedFrom: [Status.Pending],
		result: Status.PendingReference,
	},
];

const allStatuses = Object.values(Status);

describe("TST-U-04 WagerTransaction state machine", () => {
	test("TST-U-04 create is born PENDING with zeroed retry bookkeeping", () => {
		const tx = create(Kind.Bet);
		expect(tx.status).toBe(Status.Pending);
		expect(tx.isTerminal()).toBe(false);
		expect(tx.referenceAttempts).toBe(0);
		expect(tx.nextAttemptAt).toBeUndefined();
		expect(tx.observedBalance).toBeUndefined();
		expect(tx.failureCode).toBeUndefined();
		expect(tx.processedAt).toBeUndefined();
		expect(tx.createdAt).toEqual(t0);
	});

	describe.each(operations)("TST-U-04 transition $name", (op) => {
		test.each(allStatuses)("TST-U-04 %s", (from) => {
			const tx = inStatus(from);
			if (op.allowedFrom.includes(from)) {
				op.run(tx);
				expect(tx.status).toBe(op.result);
			} else {
				expect(() => op.run(tx)).toThrow(InvalidTransactionStateError);
				expect(tx.status).toBe(from);
			}
		});
	});

	test("TST-U-04 invalid transition error is a DomainError with a stable code", () => {
		try {
			inStatus(Status.Processed).reject(FailureCode.InsufficientFunds);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(DomainError);
			expect((error as DomainError).code).toBe("INVALID_TRANSACTION_STATE");
		}
	});

	test.each([Status.Processed, Status.Rejected, Status.Failed])(
		"TST-U-04 rehydrate of terminal state %s does not throw and is terminal",
		(status) => {
			const tx = inStatus(status);
			expect(tx.status).toBe(status);
			expect(tx.isTerminal()).toBe(true);
		},
	);

	test.each([Status.Pending, Status.PendingReference])(
		"TST-U-04 %s is not terminal",
		(status) => {
			expect(inStatus(status).isTerminal()).toBe(false);
		},
	);

	test("TST-U-04 rehydrate does not revalidate reference requirements", () => {
		expect(() => inStatus(Status.Processed, Kind.Refund)).not.toThrow();
	});

	test("TST-U-04 markProcessed records reference, processedAt and observed balance", () => {
		const tx = inStatus(Status.Pending, Kind.Refund);
		tx.markProcessed("tx-bet", t2, brl("75.00"));
		expect(tx.referenceTransactionId).toBe("tx-bet");
		expect(tx.processedAt).toEqual(t2);
		expect(tx.observedBalance?.toString()).toBe("75.00");
		expect(tx.nextAttemptAt).toBeUndefined();
		expect(tx.failureCode).toBeUndefined();
	});

	test("TST-U-04 markProcessed from PENDING_REFERENCE clears the schedule", () => {
		const tx = inStatus(Status.PendingReference, Kind.Refund);
		tx.markProcessed("tx-bet", t2, brl("75.00"));
		expect(tx.status).toBe(Status.Processed);
		expect(tx.nextAttemptAt).toBeUndefined();
	});

	test("TST-U-04 reject and fail record the failure code and keep processedAt empty", () => {
		const rejected = create(Kind.Bet);
		rejected.reject(FailureCode.InsufficientFunds, brl("20.00"));
		expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);
		expect(rejected.observedBalance?.toString()).toBe("20.00");
		expect(rejected.processedAt).toBeUndefined();

		const failed = create(Kind.Bet);
		failed.fail(FailureCode.ProcessingAttemptsExhausted);
		expect(failed.failureCode).toBe(FailureCode.ProcessingAttemptsExhausted);
		expect(failed.processedAt).toBeUndefined();
	});

	test("TST-U-04 reject from PENDING_REFERENCE clears the schedule", () => {
		const tx = inStatus(Status.PendingReference, Kind.Refund);
		tx.reject(FailureCode.ReferenceNotFound);
		expect(tx.nextAttemptAt).toBeUndefined();
	});

	test("TST-U-04 markPendingReference schedules the first attempt without counting it", () => {
		const tx = create(Kind.Refund, "ext-bet");
		tx.markPendingReference(t1);
		expect(tx.status).toBe(Status.PendingReference);
		expect(tx.nextAttemptAt).toEqual(t1);
		expect(tx.referenceAttempts).toBe(0);
	});

	test("TST-U-04 markPendingReference records the balance observed under the lock", () => {
		const tx = create(Kind.Refund, "ext-bet");
		tx.markPendingReference(t1, brl("100.00"));
		expect(tx.observedBalance?.toString()).toBe("100.00");
		expect(tx.referenceAttempts).toBe(0);
	});

	test("TST-U-04 a retry that stays pending is not a transition: counts and reschedules", () => {
		const tx = inStatus(Status.PendingReference, Kind.Refund);
		tx.rescheduleReference(t2);
		expect(tx.status).toBe(Status.PendingReference);
		expect(tx.referenceAttempts).toBe(1);
		expect(tx.nextAttemptAt).toEqual(t2);
		tx.rescheduleReference(new Date("2026-10-27T10:01:00.000Z"));
		expect(tx.referenceAttempts).toBe(2);
	});

	test.each(allStatuses.filter((s) => s !== Status.PendingReference))(
		"TST-U-04 rescheduleReference is invalid from %s",
		(from) => {
			expect(() => inStatus(from).rescheduleReference(t2)).toThrow(
				InvalidTransactionStateError,
			);
		},
	);

	test("TST-U-04 terminal states reject every operation, including rescheduleReference", () => {
		for (const status of [Status.Processed, Status.Rejected, Status.Failed]) {
			for (const op of operations) {
				expect(() => op.run(inStatus(status))).toThrow(
					InvalidTransactionStateError,
				);
			}
		}
	});

	test("TST-U-04 matchesPayload compares the stored hash exactly", () => {
		const tx = create(Kind.Bet);
		expect(tx.matchesPayload("hash-1")).toBe(true);
		expect(tx.matchesPayload("hash-2")).toBe(false);
		expect(tx.matchesPayload("HASH-1")).toBe(false);
	});
});

describe("TST-U-05 WagerTransaction rules by kind", () => {
	test.each([
		[Kind.Refund, true],
		[Kind.Rollback, true],
		[Kind.Win, false],
		[Kind.Loss, false],
		[Kind.Bet, false],
		[Kind.Opening, false],
	])("TST-U-05 requiresReference(%s) = %p", (kind, expected) => {
		expect(inStatus(Status.Pending, kind).requiresReference()).toBe(expected);
	});

	test.each([
		[Kind.Bet, true],
		[Kind.Win, true],
		[Kind.Refund, true],
		[Kind.Rollback, true],
		[Kind.Opening, true],
		[Kind.Loss, false],
	])("TST-U-05 affectsBalance(%s) = %p", (kind, expected) => {
		expect(inStatus(Status.Pending, kind).affectsBalance()).toBe(expected);
	});

	test.each([Kind.Refund, Kind.Rollback])(
		"TST-U-05 create requires a reference for %s",
		(kind) => {
			expect(() => create(kind)).toThrow(InvalidReferenceRequirementError);
			expect(() => create(kind, "")).toThrow(InvalidReferenceRequirementError);
			expect(create(kind, "ext-bet").referenceExternalTransactionId).toBe(
				"ext-bet",
			);
		},
	);

	test.each([Kind.Bet, Kind.Opening])(
		"TST-U-05 create forbids a reference for %s",
		(kind) => {
			expect(() => create(kind, "ext-x")).toThrow(
				InvalidReferenceRequirementError,
			);
			expect(create(kind).referenceExternalTransactionId).toBeUndefined();
		},
	);

	test.each([Kind.Win, Kind.Loss])(
		"TST-U-05 create accepts an optional reference for %s",
		(kind) => {
			expect(create(kind).referenceExternalTransactionId).toBeUndefined();
			expect(create(kind, "ext-bet").referenceExternalTransactionId).toBe(
				"ext-bet",
			);
		},
	);

	test.each([
		[Kind.Opening, LedgerDirection.Credit],
		[Kind.Win, LedgerDirection.Credit],
		[Kind.Refund, LedgerDirection.Credit],
		[Kind.Bet, LedgerDirection.Debit],
	])(
		"TST-U-05 ledgerDirectionFor(%s) = %s without reference",
		(kind, expected) => {
			expect(inStatus(Status.Pending, kind).ledgerDirectionFor()).toBe(
				expected,
			);
		},
	);

	test.each([
		[Kind.Bet, LedgerDirection.Credit],
		[Kind.Win, LedgerDirection.Debit],
		[Kind.Refund, LedgerDirection.Debit],
	])(
		"TST-U-05 ROLLBACK of a %s is the inverse direction %s",
		(refKind, expected) => {
			const rollback = inStatus(Status.Pending, Kind.Rollback);
			const reference = inStatus(Status.Processed, refKind);
			expect(rollback.ledgerDirectionFor(reference)).toBe(expected);
		},
	);

	test("TST-U-05 ROLLBACK without reference throws", () => {
		expect(() =>
			inStatus(Status.Pending, Kind.Rollback).ledgerDirectionFor(),
		).toThrow(LedgerDirectionUnavailableError);
	});

	test.each([Kind.Loss, Kind.Rollback, Kind.Opening])(
		"TST-U-05 ROLLBACK of a %s has no inverse direction",
		(refKind) => {
			expect(() =>
				inStatus(Status.Pending, Kind.Rollback).ledgerDirectionFor(
					inStatus(Status.Processed, refKind),
				),
			).toThrow(LedgerDirectionUnavailableError);
		},
	);

	test("TST-U-05 LOSS has no ledger direction", () => {
		expect(() =>
			inStatus(Status.Pending, Kind.Loss).ledgerDirectionFor(),
		).toThrow(LedgerDirectionUnavailableError);
	});

	test("TST-U-05 a reference is ignored for non-rollback kinds", () => {
		const bet = inStatus(Status.Pending, Kind.Bet);
		expect(bet.ledgerDirectionFor(inStatus(Status.Processed, Kind.Win))).toBe(
			LedgerDirection.Debit,
		);
	});
});

describe("TST-U-05 FailureCode catalog", () => {
	test("TST-U-05 matches the stable catalog of 04-api §4.1", () => {
		expect(Object.values<string>(FailureCode).sort()).toEqual(
			[
				"INSUFFICIENT_FUNDS",
				"PROCESSING_ATTEMPTS_EXHAUSTED",
				"REFERENCE_ALREADY_REVERSED",
				"REFERENCE_KIND_NOT_ALLOWED",
				"REFERENCE_MISMATCH",
				"REFERENCE_NOT_FOUND",
				"REFERENCE_NOT_PROCESSED",
				"REVERSAL_AMOUNT_MISMATCH",
				"REVERSAL_WOULD_OVERDRAW",
				"WALLET_CURRENCY_MISMATCH",
				"WALLET_PLAYER_MISMATCH",
			].sort(),
		);
	});
});
