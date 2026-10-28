import { describe, expect, test } from "bun:test";
import {
	InfrastructureUnavailableError,
	TransientPersistenceError,
} from "../../../src/modules/platform/application/persistence-errors";
import { translatePersistenceError } from "../../../src/modules/platform/infrastructure/persistence-error-translation";

const withCode = (code: string, message = "driver failure") =>
	Object.assign(new Error(message), { code });

describe("X-30 persistence error translation (boundary N14)", () => {
	test.each([
		["55P03", "lock_timeout"],
		["40P01", "deadlock"],
		["57014", "statement_timeout"],
	] as const)("X-30 %s becomes TransientPersistenceError(%s)", (code, kind) => {
		const original = withCode(code);
		const translated = translatePersistenceError(original);
		expect(translated).toBeInstanceOf(TransientPersistenceError);
		expect((translated as TransientPersistenceError).kind).toBe(kind);
		expect((translated as TransientPersistenceError).cause).toBe(original);
	});

	test.each([
		"57P01",
		"57P03",
		"08000",
		"08006",
		"08001",
		"ECONNREFUSED",
		"ECONNRESET",
		"ETIMEDOUT",
	])("X-30 %s becomes InfrastructureUnavailableError", (code) => {
		expect(translatePersistenceError(withCode(code))).toBeInstanceOf(
			InfrastructureUnavailableError,
		);
	});

	test.each([
		"Connection terminated unexpectedly",
		"timeout exceeded when trying to connect",
		"Knex: Timeout acquiring a connection. The pool is probably full.",
	])("X-30 message %j (no code) is infrastructure unavailable", (message) => {
		expect(translatePersistenceError(new Error(message))).toBeInstanceOf(
			InfrastructureUnavailableError,
		);
	});

	test("X-30 finds the code on the cause chain", () => {
		const wrapped = new Error("wrapper", { cause: withCode("40P01") });
		const translated = translatePersistenceError(wrapped);
		expect((translated as TransientPersistenceError).kind).toBe("deadlock");
	});

	test.each(["23505", "23503", "23514", "P0001", "42P01"])(
		"X-30 %s (constraint/bug) passes through untouched",
		(code) => {
			const original = withCode(code);
			expect(translatePersistenceError(original)).toBe(original);
		},
	);

	test("X-30 non-driver errors pass through untouched", () => {
		const original = new TypeError("boom");
		expect(translatePersistenceError(original)).toBe(original);
		expect(translatePersistenceError("not an error")).toBe("not an error");
	});

	test("X-30 already translated errors are not wrapped twice", () => {
		const already = new TransientPersistenceError("deadlock");
		expect(translatePersistenceError(already)).toBe(already);
	});
});
