import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CurrencyMismatchError,
	DomainError,
	InvalidMoneyError,
} from "../../../src/shared/errors";
import { Money } from "../../../src/shared/money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("TST-U-01 Money parsing and serialization", () => {
	test("TST-U-01 round-trips a valid amount through toJSON", () => {
		expect(brl("25.00").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
	});

	test("TST-U-01 accepts zero and 17 integer digits", () => {
		expect(brl("0.00").toJSON().amount).toBe("0.00");
		expect(brl("12345678901234567.99").toJSON().amount).toBe(
			"12345678901234567.99",
		);
	});

	test("TST-U-01 toString and toJSON always use two decimals", () => {
		expect(brl("7.50").toString()).toBe("7.50");
		expect(brl("0.00").toString()).toBe("0.00");
		expect(brl("10000000000000000.00").toString()).toBe("10000000000000000.00");
	});

	test("TST-U-01 zero(currency) builds 0.00", () => {
		expect(Money.zero("USD").toJSON()).toEqual({
			amount: "0.00",
			currency: "USD",
		});
		expect(Money.zero("USD").isZero()).toBe(true);
	});

	test.each([
		["NaN", "NaN"],
		["Infinity", "Infinity"],
		["-Infinity", "-Infinity"],
		["scientific notation", "1e3"],
		["scientific notation with decimals", "1.00e3"],
		["empty", ""],
		["blank", "  "],
		["three decimals", "1.234"],
		["one decimal", "1.5"],
		["no decimals", "10"],
		["negative", "-1.00"],
		["negative zero", "-0.00"],
		["plus sign", "+1.00"],
		["comma separator", "1,00"],
		["leading space", " 1.00"],
		["trailing newline", "1.00\n"],
		["no integer part", ".50"],
		["18 integer digits", "123456789012345678.00"],
		["non-ascii digits", "١.٠٠"],
		["hex", "0x10.00"],
	])("TST-U-01 rejects %s", (_name, amount) => {
		expect(() => brl(amount)).toThrow(InvalidMoneyError);
	});

	test.each([
		["lowercase", "brl"],
		["two letters", "BR"],
		["four letters", "BRLL"],
		["empty", ""],
		["digits", "B1L"],
	])("TST-U-01 rejects %s currency", (_name, currency) => {
		expect(() => Money.from({ amount: "1.00", currency })).toThrow(
			InvalidMoneyError,
		);
		expect(() => Money.zero(currency)).toThrow(InvalidMoneyError);
	});

	test("TST-U-01 rejects a runtime number even when it looks valid", () => {
		const props = { amount: 25, currency: "BRL" } as unknown as {
			amount: string;
			currency: string;
		};
		expect(() => Money.from(props)).toThrow(InvalidMoneyError);
	});

	test("TST-U-01 rejects non-string amounts of any type", () => {
		for (const amount of [null, undefined, {}, [], true, 1n, Number.NaN]) {
			const props = { amount, currency: "BRL" } as unknown as {
				amount: string;
				currency: string;
			};
			expect(() => Money.from(props)).toThrow(InvalidMoneyError);
		}
	});

	test("TST-U-01 errors are DomainErrors with stable codes", () => {
		try {
			brl("1.234");
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(DomainError);
			expect((error as DomainError).code).toBe("INVALID_MONEY");
		}
	});
});

describe("TST-U-02 Money arithmetic and immutability", () => {
	test("TST-U-02 adds exactly (0.10 + 0.20 = 0.30)", () => {
		expect(brl("0.10").add(brl("0.20")).toString()).toBe("0.30");
		expect(brl("0.10").add(brl("0.20")).equals(brl("0.30"))).toBe(true);
	});

	test("TST-U-02 subtracts exactly", () => {
		expect(brl("0.30").subtract(brl("0.10")).toString()).toBe("0.20");
		expect(brl("100.00").subtract(brl("80.00")).toString()).toBe("20.00");
	});

	test("TST-U-02 handles values beyond number precision", () => {
		const big = brl("12345678901234567.99");
		expect(big.add(brl("0.01")).toString()).toBe("12345678901234568.00");
		expect(big.subtract(brl("0.99")).toString()).toBe("12345678901234567.00");
	});

	// subtract/negate may yield negative values in memory: from() rejects them,
	// but the balance check and isNegative() depend on them.
	test("TST-U-02 subtract and negate may produce negative values in memory", () => {
		const diff = brl("20.00").subtract(brl("80.00"));
		expect(diff.isNegative()).toBe(true);
		expect(diff.isPositive()).toBe(false);
		expect(diff.toString()).toBe("-60.00");
		expect(brl("5.00").negate().toString()).toBe("-5.00");
		expect(brl("5.00").negate().isNegative()).toBe(true);
		expect(brl("5.00").negate().negate().equals(brl("5.00"))).toBe(true);
	});

	test("TST-U-02 negating zero is not negative", () => {
		expect(Money.zero("BRL").negate().isNegative()).toBe(false);
		expect(Money.zero("BRL").negate().toString()).toBe("0.00");
	});

	test("TST-U-02 sign predicates", () => {
		expect(brl("0.00").isZero()).toBe(true);
		expect(brl("0.00").isPositive()).toBe(false);
		expect(brl("0.01").isPositive()).toBe(true);
		expect(brl("0.01").isZero()).toBe(false);
		expect(brl("0.01").isNegative()).toBe(false);
	});

	test("TST-U-02 comparisons", () => {
		expect(brl("1.00").isLessThan(brl("1.01"))).toBe(true);
		expect(brl("1.01").isLessThan(brl("1.00"))).toBe(false);
		expect(brl("1.00").isLessThan(brl("1.00"))).toBe(false);
		expect(brl("1.00").equals(brl("1.00"))).toBe(true);
		expect(brl("1.00").equals(brl("1.01"))).toBe(false);
		expect(brl("01.00").equals(brl("1.00"))).toBe(true);
	});

	test("TST-U-02 operations return new instances and leave the original intact", () => {
		const a = brl("10.00");
		const b = brl("2.50");
		const sum = a.add(b);
		const diff = a.subtract(b);
		const neg = a.negate();
		expect(sum).not.toBe(a);
		expect(diff).not.toBe(a);
		expect(neg).not.toBe(a);
		expect(a.toString()).toBe("10.00");
		expect(b.toString()).toBe("2.50");
	});

	test("TST-U-02 different currencies throw CurrencyMismatchError", () => {
		const usd = Money.from({ amount: "1.00", currency: "USD" });
		expect(() => brl("1.00").add(usd)).toThrow(CurrencyMismatchError);
		expect(() => brl("1.00").subtract(usd)).toThrow(CurrencyMismatchError);
		expect(() => brl("1.00").isLessThan(usd)).toThrow(CurrencyMismatchError);
		expect(() => brl("1.00").equals(usd)).toThrow(CurrencyMismatchError);
	});

	test("TST-U-02 CurrencyMismatchError is a DomainError with a stable code", () => {
		try {
			brl("1.00").add(Money.zero("USD"));
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(DomainError);
			expect((error as DomainError).code).toBe("CURRENCY_MISMATCH");
		}
	});

	test("TST-U-02 does not change the global big.js configuration", async () => {
		const { default: Big } = await import("big.js");
		expect(Big.DP).toBe(20);
		expect(Big.RM).toBe(1);
	});

	test("TST-U-02 JSON.stringify serializes amount as a string", () => {
		expect(JSON.stringify({ m: brl("3.10") })).toBe(
			'{"m":{"amount":"3.10","currency":"BRL"}}',
		);
	});

	test("TST-U-02 source has no conversion to number", () => {
		const dir = join(import.meta.dir, "..", "..", "..", "src", "shared");
		const files = readdirSync(dir).filter((f) => f.startsWith("money"));
		expect(files.length).toBeGreaterThan(0);
		const forbidden = [
			/Number\(/,
			/parseFloat/,
			/parseInt/,
			/toNumber/,
			/valueOf/,
			/unary-plus/,
		];
		for (const file of files) {
			const source = readFileSync(join(dir, file), "utf8");
			for (const pattern of forbidden) {
				expect({
					file,
					pattern: String(pattern),
					hit: pattern.test(source),
				}).toEqual({ file, pattern: String(pattern), hit: false });
			}
		}
	});
});
