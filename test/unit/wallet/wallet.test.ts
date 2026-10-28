import { describe, expect, test } from "bun:test";
import {
	InsufficientFundsError,
	Wallet,
} from "../../../src/modules/wallet/domain/wallet";
import { LedgerDirection } from "../../../src/modules/wallet/domain/wallet-ledger-entry";
import { CurrencyMismatchError, DomainError } from "../../../src/shared/errors";
import { Money } from "../../../src/shared/money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const t0 = new Date("2026-10-27T10:00:00.000Z");
const t1 = new Date("2026-10-27T10:00:05.000Z");

const open = (balance = "100.00") =>
	Wallet.open({
		id: "wallet-1",
		playerId: "player-1",
		initialBalance: brl(balance),
		now: t0,
	});

describe("TST-U-03 Wallet", () => {
	test("TST-U-03 open starts at version 1 with the initial balance", () => {
		const wallet = open();
		expect(wallet.version).toBe(1);
		expect(wallet.balance.toString()).toBe("100.00");
		expect(wallet.currency).toBe("BRL");
		expect(wallet.createdAt).toEqual(t0);
		expect(wallet.updatedAt).toEqual(t0);
	});

	test("TST-U-03 open with zero balance also starts at version 1", () => {
		const wallet = open("0.00");
		expect(wallet.version).toBe(1);
		expect(wallet.balance.isZero()).toBe(true);
	});

	test("TST-U-03 open rejects a negative initial balance", () => {
		expect(() => open()).not.toThrow();
		expect(() =>
			Wallet.open({
				id: "w",
				playerId: "p",
				initialBalance: brl("1.00").negate(),
				now: t0,
			}),
		).toThrow(DomainError);
	});

	test("TST-U-03 debit lowers the balance, bumps version and returns the ledger entry", () => {
		const wallet = open();
		const entry = wallet.debit(brl("80.00"), "tx-1", t1, "entry-1");
		expect(wallet.balance.toString()).toBe("20.00");
		expect(wallet.version).toBe(2);
		expect(wallet.updatedAt).toEqual(t1);
		expect(entry.direction).toBe(LedgerDirection.Debit);
		expect(entry.id).toBe("entry-1");
		expect(entry.walletId).toBe("wallet-1");
		expect(entry.transactionId).toBe("tx-1");
		expect(entry.walletVersion).toBe(2);
		expect(entry.balanceBefore.toString()).toBe("100.00");
		expect(entry.balanceAfter.toString()).toBe("20.00");
		expect(entry.money.toString()).toBe("80.00");
		expect(entry.createdAt).toEqual(t1);
		expect(entry.isBalanced()).toBe(true);
	});

	test("TST-U-03 credit raises the balance, bumps version and returns the ledger entry", () => {
		const wallet = open("20.00");
		const entry = wallet.credit(brl("30.25"), "tx-2", t1, "entry-2");
		expect(wallet.balance.toString()).toBe("50.25");
		expect(wallet.version).toBe(2);
		expect(entry.direction).toBe(LedgerDirection.Credit);
		expect(entry.walletVersion).toBe(2);
		expect(entry.balanceBefore.toString()).toBe("20.00");
		expect(entry.balanceAfter.toString()).toBe("50.25");
	});

	test("TST-U-03 debit of the exact balance is allowed", () => {
		const wallet = open("10.00");
		wallet.debit(brl("10.00"), "tx-1", t1, "entry-1");
		expect(wallet.balance.isZero()).toBe(true);
		expect(wallet.version).toBe(2);
	});

	test("TST-U-03 insufficient funds throws and changes nothing", () => {
		const wallet = open("100.00");
		expect(() => wallet.debit(brl("100.01"), "tx-1", t1, "entry-1")).toThrow(
			InsufficientFundsError,
		);
		expect(wallet.balance.toString()).toBe("100.00");
		expect(wallet.version).toBe(1);
		expect(wallet.updatedAt).toEqual(t0);
	});

	test("TST-U-03 balance never goes negative across a sequence of operations", () => {
		const wallet = open("100.00");
		wallet.debit(brl("80.00"), "tx-1", t1, "e1");
		expect(() => wallet.debit(brl("80.00"), "tx-2", t1, "e2")).toThrow(
			InsufficientFundsError,
		);
		expect(wallet.balance.isNegative()).toBe(false);
		expect(wallet.balance.toString()).toBe("20.00");
		expect(wallet.version).toBe(2);
	});

	test("TST-U-03 InsufficientFundsError is a DomainError with a stable code", () => {
		try {
			open("1.00").debit(brl("2.00"), "tx", t1, "e");
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(DomainError);
			expect((error as DomainError).code).toBe("INSUFFICIENT_FUNDS");
		}
	});

	test("TST-U-03 different currency throws and changes nothing", () => {
		const wallet = open();
		const usd = Money.from({ amount: "1.00", currency: "USD" });
		expect(() => wallet.debit(usd, "tx-1", t1, "e1")).toThrow(
			CurrencyMismatchError,
		);
		expect(() => wallet.credit(usd, "tx-1", t1, "e1")).toThrow(
			CurrencyMismatchError,
		);
		expect(wallet.balance.toString()).toBe("100.00");
		expect(wallet.version).toBe(1);
	});

	test("TST-U-03 zero or negative amounts are rejected and do not bump version", () => {
		const wallet = open();
		for (const amount of [Money.zero("BRL"), brl("1.00").negate()]) {
			expect(() => wallet.debit(amount, "tx", t1, "e")).toThrow(DomainError);
			expect(() => wallet.credit(amount, "tx", t1, "e")).toThrow(DomainError);
		}
		expect(wallet.version).toBe(1);
		expect(wallet.balance.toString()).toBe("100.00");
	});

	test("TST-U-03 version increments exactly once per balance change", () => {
		const wallet = open("0.00");
		wallet.credit(brl("10.00"), "tx-1", t1, "e1");
		wallet.credit(brl("10.00"), "tx-2", t1, "e2");
		wallet.debit(brl("5.00"), "tx-3", t1, "e3");
		expect(wallet.version).toBe(4);
	});

	test("TST-U-03 ledger entries chain: each balanceBefore equals the previous balanceAfter", () => {
		const wallet = open("100.00");
		const a = wallet.debit(brl("30.00"), "tx-1", t1, "e1");
		const b = wallet.credit(brl("5.00"), "tx-2", t1, "e2");
		expect(b.balanceBefore.equals(a.balanceAfter)).toBe(true);
		expect(b.walletVersion).toBe(a.walletVersion + 1);
	});

	test("TST-U-03 rehydrate rebuilds the persisted state without validating it", () => {
		const wallet = Wallet.rehydrate({
			id: "w",
			playerId: "p",
			balance: brl("42.00"),
			version: 7,
			createdAt: t0,
			updatedAt: t1,
		});
		expect(wallet.version).toBe(7);
		expect(wallet.balance.toString()).toBe("42.00");
		expect(wallet.createdAt).toEqual(t0);
		expect(wallet.updatedAt).toEqual(t1);
		const entry = wallet.credit(brl("1.00"), "tx", t1, "e");
		expect(entry.walletVersion).toBe(8);
	});

	test("TST-U-03 balance getter is a snapshot: mutating the wallet leaves old Money intact", () => {
		const wallet = open();
		const before = wallet.balance;
		wallet.debit(brl("1.00"), "tx", t1, "e");
		expect(before.toString()).toBe("100.00");
	});
});
