import { describe, expect, test } from "bun:test";
import {
	LedgerDirection,
	WalletLedgerEntry,
} from "../../../src/modules/wallet/domain/wallet-ledger-entry";
import { DomainError } from "../../../src/shared/errors";
import { Money } from "../../../src/shared/money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-10-27T10:00:00.000Z");

const props = (
	overrides: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {},
) => ({
	id: "entry-1",
	walletId: "wallet-1",
	transactionId: "tx-1",
	walletVersion: 2,
	direction: LedgerDirection.Debit,
	money: brl("80.00"),
	balanceBefore: brl("100.00"),
	balanceAfter: brl("20.00"),
	createdAt: at,
	...overrides,
});

describe("TST-U-07 WalletLedgerEntry", () => {
	test("TST-U-07 creates a balanced DEBIT entry", () => {
		const entry = WalletLedgerEntry.create(props());
		expect(entry.isBalanced()).toBe(true);
		expect(entry.direction).toBe(LedgerDirection.Debit);
		expect(entry.walletVersion).toBe(2);
		expect(entry.balanceAfter.toString()).toBe("20.00");
	});

	test("TST-U-07 creates a balanced CREDIT entry", () => {
		const entry = WalletLedgerEntry.create(
			props({
				direction: LedgerDirection.Credit,
				money: brl("5.50"),
				balanceBefore: brl("20.00"),
				balanceAfter: brl("25.50"),
			}),
		);
		expect(entry.isBalanced()).toBe(true);
	});

	test("TST-U-07 rejects a DEBIT whose balanceAfter adds instead of subtracting", () => {
		expect(() =>
			WalletLedgerEntry.create(props({ balanceAfter: brl("180.00") })),
		).toThrow(DomainError);
	});

	test("TST-U-07 rejects a CREDIT whose balanceAfter subtracts", () => {
		expect(() =>
			WalletLedgerEntry.create(
				props({
					direction: LedgerDirection.Credit,
					balanceAfter: brl("20.00"),
				}),
			),
		).toThrow(DomainError);
	});

	test("TST-U-07 rejects off-by-one-cent arithmetic", () => {
		expect(() =>
			WalletLedgerEntry.create(props({ balanceAfter: brl("20.01") })),
		).toThrow(DomainError);
	});

	test("TST-U-07 rejects zero amounts", () => {
		expect(() =>
			WalletLedgerEntry.create(
				props({ money: Money.zero("BRL"), balanceAfter: brl("100.00") }),
			),
		).toThrow(DomainError);
	});

	test("TST-U-07 rejects mixed currencies", () => {
		expect(() =>
			WalletLedgerEntry.create(
				props({ money: Money.from({ amount: "80.00", currency: "USD" }) }),
			),
		).toThrow(DomainError);
	});

	test("TST-U-07 rejects walletVersion below 1 or fractional", () => {
		expect(() => WalletLedgerEntry.create(props({ walletVersion: 0 }))).toThrow(
			DomainError,
		);
		expect(() =>
			WalletLedgerEntry.create(props({ walletVersion: 1.5 })),
		).toThrow(DomainError);
	});

	test("TST-U-07 rejects negative balances", () => {
		expect(() =>
			WalletLedgerEntry.create(
				props({ money: brl("120.00"), balanceAfter: brl("-20.00") }),
			),
		).toThrow(DomainError);
	});

	test("TST-U-07 rehydrate does not revalidate, isBalanced exposes the inconsistency", () => {
		const entry = WalletLedgerEntry.rehydrate(
			props({ balanceAfter: brl("999.00") }),
		);
		expect(entry.isBalanced()).toBe(false);
	});

	test("TST-U-07 has no mutable state: fields are frozen", () => {
		const entry = WalletLedgerEntry.create(props());
		const mutable = entry as unknown as Record<string, unknown>;
		expect(Object.isFrozen(entry)).toBe(true);
		expect(() => {
			mutable.direction = "CREDIT";
		}).toThrow(TypeError);
		expect(entry.direction).toBe(LedgerDirection.Debit);
	});
});
