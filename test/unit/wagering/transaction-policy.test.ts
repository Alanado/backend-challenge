import { describe, expect, test } from "bun:test";
import { FailureCode } from "../../../src/modules/wagering/domain/failure-code";
import {
	allowedReferenceKinds,
	decideTransaction,
	type TransactionDecision,
} from "../../../src/modules/wagering/domain/transaction-policy";
import {
	WagerTransaction,
	type WagerTransactionState,
} from "../../../src/modules/wagering/domain/wager-transaction";
import { WagerTransactionKind as Kind } from "../../../src/modules/wagering/domain/wager-transaction-kind";
import { WagerTransactionStatus as Status } from "../../../src/modules/wagering/domain/wager-transaction-status";
import { Wallet } from "../../../src/modules/wallet/domain/wallet";
import { LedgerDirection } from "../../../src/modules/wallet/domain/wallet-ledger-entry";
import { DomainError } from "../../../src/shared/errors";
import { Money } from "../../../src/shared/money";

const money = (amount: string, currency = "BRL") =>
	Money.from({ amount, currency });
const t0 = new Date("2026-10-27T10:00:00.000Z");

const wallet = (
	balance = "100.00",
	overrides: { playerId?: string; currency?: string } = {},
) =>
	Wallet.rehydrate({
		id: "wallet-1",
		playerId: overrides.playerId ?? "player-1",
		balance: money(balance, overrides.currency ?? "BRL"),
		version: 3,
		createdAt: t0,
		updatedAt: t0,
	});

const tx = (
	kind: Kind,
	overrides: Partial<WagerTransactionState> = {},
): WagerTransaction =>
	WagerTransaction.rehydrate({
		id: "tx-1",
		providerId: "prov",
		externalTransactionId: "ext-1",
		idempotencyKey: "prov:ext-1",
		payloadHash: "h",
		walletId: "wallet-1",
		playerId: "player-1",
		roundId: "round-1",
		gameId: "game-1",
		kind,
		money: money("25.00"),
		referenceExternalTransactionId:
			kind === Kind.Bet || kind === Kind.Opening ? undefined : "ext-ref",
		createdAt: t0,
		status: Status.Pending,
		referenceTransactionId: undefined,
		failureCode: undefined,
		processedAt: undefined,
		observedBalance: undefined,
		referenceAttempts: 0,
		nextAttemptAt: undefined,
		...overrides,
	});

const ref = (
	kind: Kind,
	overrides: Partial<WagerTransactionState> = {},
	alreadyReversed = false,
) => ({
	transaction: tx(kind, {
		id: "tx-ref",
		externalTransactionId: "ext-ref",
		referenceExternalTransactionId: undefined,
		status: Status.Processed,
		processedAt: t0,
		...overrides,
	}),
	alreadyReversed,
});

const reject = (failureCode: FailureCode): TransactionDecision => ({
	type: "REJECT",
	failureCode,
});
const apply = (
	direction: LedgerDirection | undefined,
): TransactionDecision => ({
	type: "APPLY",
	direction,
});
const pending: TransactionDecision = { type: "PENDING_REFERENCE" };

describe("TST-U-05 policy: kind without reference", () => {
	test("TST-U-05 BET debits when the balance covers it", () => {
		expect(
			decideTransaction({
				wallet: wallet("100.00"),
				transaction: tx(Kind.Bet),
				reference: undefined,
			}),
		).toEqual(apply(LedgerDirection.Debit));
	});

	test("TST-U-05 BET for exactly the balance is accepted", () => {
		expect(
			decideTransaction({
				wallet: wallet("25.00"),
				transaction: tx(Kind.Bet),
				reference: undefined,
			}),
		).toEqual(apply(LedgerDirection.Debit));
	});

	test("TST-U-05 BET without enough balance is INSUFFICIENT_FUNDS", () => {
		expect(
			decideTransaction({
				wallet: wallet("24.99"),
				transaction: tx(Kind.Bet),
				reference: undefined,
			}),
		).toEqual(reject(FailureCode.InsufficientFunds));
	});

	test("TST-U-05 WIN without reference credits", () => {
		expect(
			decideTransaction({
				wallet: wallet("0.00"),
				transaction: tx(Kind.Win, {
					referenceExternalTransactionId: undefined,
				}),
				reference: undefined,
			}),
		).toEqual(apply(LedgerDirection.Credit));
	});

	test("TST-U-05 LOSS without reference is applied with no ledger direction", () => {
		expect(
			decideTransaction({
				wallet: wallet("0.00"),
				transaction: tx(Kind.Loss, {
					referenceExternalTransactionId: undefined,
				}),
				reference: undefined,
			}),
		).toEqual(apply(undefined));
	});
});

describe("TST-U-05 policy: allowed reference kinds matrix", () => {
	test("TST-U-05 allowedReferenceKinds table", () => {
		expect(allowedReferenceKinds(Kind.Refund)).toEqual([Kind.Bet]);
		expect(allowedReferenceKinds(Kind.Rollback)).toEqual([
			Kind.Bet,
			Kind.Win,
			Kind.Refund,
		]);
		expect(allowedReferenceKinds(Kind.Win)).toEqual([Kind.Bet]);
		expect(allowedReferenceKinds(Kind.Loss)).toEqual([Kind.Bet]);
		expect(allowedReferenceKinds(Kind.Bet)).toEqual([]);
		expect(allowedReferenceKinds(Kind.Opening)).toEqual([]);
	});

	const expected: Array<[Kind, Kind, TransactionDecision]> = [
		[Kind.Refund, Kind.Bet, apply(LedgerDirection.Credit)],
		[Kind.Refund, Kind.Win, reject(FailureCode.ReferenceKindNotAllowed)],
		[Kind.Refund, Kind.Loss, reject(FailureCode.ReferenceKindNotAllowed)],
		[Kind.Refund, Kind.Refund, reject(FailureCode.ReferenceKindNotAllowed)],
		[Kind.Refund, Kind.Rollback, reject(FailureCode.ReferenceKindNotAllowed)],
		[Kind.Rollback, Kind.Bet, apply(LedgerDirection.Credit)],
		[Kind.Rollback, Kind.Win, apply(LedgerDirection.Debit)],
		[Kind.Rollback, Kind.Refund, apply(LedgerDirection.Debit)],
		[Kind.Rollback, Kind.Loss, reject(FailureCode.ReferenceKindNotAllowed)],
		[Kind.Rollback, Kind.Rollback, reject(FailureCode.ReferenceKindNotAllowed)],
		[Kind.Win, Kind.Bet, apply(LedgerDirection.Credit)],
		[Kind.Win, Kind.Win, reject(FailureCode.ReferenceKindNotAllowed)],
		[Kind.Win, Kind.Loss, reject(FailureCode.ReferenceKindNotAllowed)],
		[Kind.Win, Kind.Refund, reject(FailureCode.ReferenceKindNotAllowed)],
		[Kind.Win, Kind.Rollback, reject(FailureCode.ReferenceKindNotAllowed)],
		[Kind.Loss, Kind.Bet, apply(undefined)],
		[Kind.Loss, Kind.Win, reject(FailureCode.ReferenceKindNotAllowed)],
		[Kind.Loss, Kind.Loss, reject(FailureCode.ReferenceKindNotAllowed)],
		[Kind.Loss, Kind.Refund, reject(FailureCode.ReferenceKindNotAllowed)],
		[Kind.Loss, Kind.Rollback, reject(FailureCode.ReferenceKindNotAllowed)],
	];

	test.each(expected)(
		"TST-U-05 %s referencing %s",
		(kind, referenceKind, decision) => {
			// Plenty of balance, equal amounts, same wallet/player/round/currency.
			expect(
				decideTransaction({
					wallet: wallet("1000.00"),
					transaction: tx(kind),
					reference: ref(referenceKind),
				}),
			).toEqual(decision);
		},
	);
});

describe("TST-U-05 policy: reference resolution", () => {
	const reversals = [Kind.Refund, Kind.Rollback, Kind.Win, Kind.Loss];

	test.each(reversals)(
		"TST-U-05 %s with an unknown reference stays pending",
		(kind) => {
			expect(
				decideTransaction({
					wallet: wallet(),
					transaction: tx(kind),
					reference: undefined,
				}),
			).toEqual(pending);
		},
	);

	test.each([
		["PENDING_REFERENCE", Status.PendingReference, pending],
		["REJECTED", Status.Rejected, reject(FailureCode.ReferenceNotProcessed)],
		["FAILED", Status.Failed, reject(FailureCode.ReferenceNotProcessed)],
	])("TST-U-05 reference in %s", (_name, status, decision) => {
		const reference = ref(Kind.Bet, {
			status,
			processedAt: undefined,
			nextAttemptAt: status === Status.PendingReference ? t0 : undefined,
			failureCode:
				status === Status.Processed ? undefined : FailureCode.InsufficientFunds,
		});
		expect(
			decideTransaction({
				wallet: wallet(),
				transaction: tx(Kind.Refund),
				reference,
			}),
		).toEqual(decision);
	});

	test("TST-U-05 a reference still PENDING is an impossible fact and throws", () => {
		const reference = ref(Kind.Bet, {
			status: Status.Pending,
			processedAt: undefined,
		});
		expect(() =>
			decideTransaction({
				wallet: wallet(),
				transaction: tx(Kind.Refund),
				reference,
			}),
		).toThrow(DomainError);
	});

	test("TST-U-05 an already reversed reference is REFERENCE_ALREADY_REVERSED", () => {
		expect(
			decideTransaction({
				wallet: wallet(),
				transaction: tx(Kind.Rollback),
				reference: ref(Kind.Bet, {}, true),
			}),
		).toEqual(reject(FailureCode.ReferenceAlreadyReversed));
	});

	test.each([
		["walletId", { walletId: "wallet-2" }],
		["playerId", { playerId: "player-2" }],
		["roundId", { roundId: "round-2" }],
		["currency", { money: money("25.00", "USD") }],
	])(
		"TST-U-05 reference with different %s is REFERENCE_MISMATCH",
		(_field, change) => {
			expect(
				decideTransaction({
					wallet: wallet(),
					transaction: tx(Kind.Refund),
					reference: ref(Kind.Bet, change),
				}),
			).toEqual(reject(FailureCode.ReferenceMismatch));
		},
	);

	test.each([Kind.Refund, Kind.Rollback])(
		"TST-U-05 %s with an amount different from the reference is REVERSAL_AMOUNT_MISMATCH",
		(kind) => {
			for (const amount of ["24.99", "25.01"]) {
				expect(
					decideTransaction({
						wallet: wallet(),
						transaction: tx(kind),
						reference: ref(Kind.Bet, { money: money(amount) }),
					}),
				).toEqual(reject(FailureCode.ReversalAmountMismatch));
			}
		},
	);

	test.each([Kind.Win, Kind.Loss])(
		"TST-U-05 %s may have an amount different from its BET (not a reversal)",
		(kind) => {
			expect(
				decideTransaction({
					wallet: wallet(),
					transaction: tx(kind),
					reference: ref(Kind.Bet, { money: money("10.00") }),
				}).type,
			).toBe("APPLY");
		},
	);
});

describe("TST-U-05 policy: balance checks on reversals", () => {
	test("TST-U-05 ROLLBACK of a WIN that would overdraw is REVERSAL_WOULD_OVERDRAW", () => {
		expect(
			decideTransaction({
				wallet: wallet("24.99"),
				transaction: tx(Kind.Rollback),
				reference: ref(Kind.Win),
			}),
		).toEqual(reject(FailureCode.ReversalWouldOverdraw));
	});

	test("TST-U-05 ROLLBACK of a REFUND that would overdraw is REVERSAL_WOULD_OVERDRAW", () => {
		expect(
			decideTransaction({
				wallet: wallet("0.00"),
				transaction: tx(Kind.Rollback),
				reference: ref(Kind.Refund),
			}),
		).toEqual(reject(FailureCode.ReversalWouldOverdraw));
	});

	test("TST-U-05 ROLLBACK of a WIN for exactly the balance is accepted", () => {
		expect(
			decideTransaction({
				wallet: wallet("25.00"),
				transaction: tx(Kind.Rollback),
				reference: ref(Kind.Win),
			}),
		).toEqual(apply(LedgerDirection.Debit));
	});

	test.each([Kind.Refund, Kind.Rollback])(
		"TST-U-05 credit reversals (%s of a BET) never overdraw, even at zero balance",
		(kind) => {
			expect(
				decideTransaction({
					wallet: wallet("0.00"),
					transaction: tx(kind),
					reference: ref(Kind.Bet),
				}),
			).toEqual(apply(LedgerDirection.Credit));
		},
	);

	test("TST-U-05 insufficient funds and overdraw use distinct codes", () => {
		const bet = decideTransaction({
			wallet: wallet("0.00"),
			transaction: tx(Kind.Bet),
			reference: undefined,
		});
		const rollback = decideTransaction({
			wallet: wallet("0.00"),
			transaction: tx(Kind.Rollback),
			reference: ref(Kind.Win),
		});
		expect(bet).not.toEqual(rollback);
	});
});

describe("TST-U-05 policy: order of checks (first deviation wins)", () => {
	// Every case below also violates all later checks; only the first one must be reported.
	const badReference = (change: Partial<WagerTransactionState>) =>
		ref(Kind.Win, change);

	test("TST-U-05 wallet player mismatch beats everything, including a missing reference", () => {
		expect(
			decideTransaction({
				wallet: wallet("0.00", { playerId: "someone-else" }),
				transaction: tx(Kind.Rollback),
				reference: undefined,
			}),
		).toEqual(reject(FailureCode.WalletPlayerMismatch));
	});

	test("TST-U-05 wallet player mismatch beats wallet currency mismatch", () => {
		expect(
			decideTransaction({
				wallet: wallet("0.00", { playerId: "someone-else", currency: "USD" }),
				transaction: tx(Kind.Bet),
				reference: undefined,
			}),
		).toEqual(reject(FailureCode.WalletPlayerMismatch));
	});

	test("TST-U-05 wallet currency mismatch beats a missing reference and insufficient funds", () => {
		expect(
			decideTransaction({
				wallet: wallet("0.00", { currency: "USD" }),
				transaction: tx(Kind.Refund),
				reference: undefined,
			}),
		).toEqual(reject(FailureCode.WalletCurrencyMismatch));
		expect(
			decideTransaction({
				wallet: wallet("0.00", { currency: "USD" }),
				transaction: tx(Kind.Bet),
				reference: undefined,
			}),
		).toEqual(reject(FailureCode.WalletCurrencyMismatch));
	});

	test("TST-U-05 a missing reference (pending) beats the balance check", () => {
		expect(
			decideTransaction({
				wallet: wallet("0.00"),
				transaction: tx(Kind.Rollback),
				reference: undefined,
			}),
		).toEqual(pending);
	});

	test("TST-U-05 kind not allowed beats mismatch, amount, status, reversed and overdraw", () => {
		expect(
			decideTransaction({
				wallet: wallet("0.00"),
				transaction: tx(Kind.Refund),
				reference: ref(
					Kind.Win,
					{
						walletId: "w2",
						money: money("1.00"),
						status: Status.Rejected,
						processedAt: undefined,
						failureCode: FailureCode.InsufficientFunds,
					},
					true,
				),
			}),
		).toEqual(reject(FailureCode.ReferenceKindNotAllowed));
	});

	test("TST-U-05 reference mismatch beats amount, status, reversed and overdraw", () => {
		expect(
			decideTransaction({
				wallet: wallet("0.00"),
				transaction: tx(Kind.Rollback),
				reference: badReference({
					roundId: "other-round",
					money: money("1.00"),
					status: Status.Rejected,
					processedAt: undefined,
					failureCode: FailureCode.InsufficientFunds,
				}),
			}),
		).toEqual(reject(FailureCode.ReferenceMismatch));
	});

	test("TST-U-05 amount mismatch beats status, reversed and overdraw", () => {
		expect(
			decideTransaction({
				wallet: wallet("0.00"),
				transaction: tx(Kind.Rollback),
				reference: ref(
					Kind.Win,
					{
						money: money("1.00"),
						status: Status.PendingReference,
						processedAt: undefined,
						nextAttemptAt: t0,
					},
					true,
				),
			}),
		).toEqual(reject(FailureCode.ReversalAmountMismatch));
	});

	test("TST-U-05 a pending reference beats the not-processed and already-reversed checks", () => {
		expect(
			decideTransaction({
				wallet: wallet("0.00"),
				transaction: tx(Kind.Rollback),
				reference: ref(
					Kind.Win,
					{
						status: Status.PendingReference,
						processedAt: undefined,
						nextAttemptAt: t0,
					},
					true,
				),
			}),
		).toEqual(pending);
	});

	test("TST-U-05 a not-processed reference beats already-reversed and overdraw", () => {
		expect(
			decideTransaction({
				wallet: wallet("0.00"),
				transaction: tx(Kind.Rollback),
				reference: ref(
					Kind.Win,
					{
						status: Status.Failed,
						processedAt: undefined,
						failureCode: FailureCode.ProcessingAttemptsExhausted,
					},
					true,
				),
			}),
		).toEqual(reject(FailureCode.ReferenceNotProcessed));
	});

	test("TST-U-05 already reversed beats overdraw", () => {
		expect(
			decideTransaction({
				wallet: wallet("0.00"),
				transaction: tx(Kind.Rollback),
				reference: ref(Kind.Win, {}, true),
			}),
		).toEqual(reject(FailureCode.ReferenceAlreadyReversed));
	});

	test("TST-U-05 overdraw is reported only when every earlier check passed", () => {
		expect(
			decideTransaction({
				wallet: wallet("0.00"),
				transaction: tx(Kind.Rollback),
				reference: ref(Kind.Win),
			}),
		).toEqual(reject(FailureCode.ReversalWouldOverdraw));
	});
});
