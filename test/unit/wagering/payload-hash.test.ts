import { describe, expect, test } from "bun:test";
import { IdempotencyKey } from "../../../src/modules/wagering/domain/idempotency-key";
import {
	type PayloadHashInput,
	payloadHash,
} from "../../../src/modules/wagering/domain/payload-hash";
import { WagerTransactionKind as Kind } from "../../../src/modules/wagering/domain/wager-transaction-kind";
import {
	DomainError,
	InvalidIdempotencyKeyError,
} from "../../../src/shared/errors";
import { Money } from "../../../src/shared/money";

const PLAYER = "0190a1b2-0000-7000-8000-000000000001";
const WALLET = "0190a1b2-0000-7000-8000-000000000002";

const base = (): PayloadHashInput => ({
	providerId: "prov-a",
	externalTransactionId: "ext-1",
	playerId: PLAYER,
	walletId: WALLET,
	roundId: "round-1",
	gameId: "game-1",
	kind: Kind.Bet,
	money: Money.from({ amount: "25.00", currency: "BRL" }),
});

// Locks the algorithm of 04-api §6. Canonical form hashed (one line, no spaces):
// {"externalTransactionId":"ext-1","gameId":"game-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"},
//  "playerId":"<PLAYER>","providerId":"prov-a","roundId":"round-1","walletId":"<WALLET>"}
const GOLDEN_BET =
	"48a719c83af048d742507973ad6313ea298022f77e20a0d89f9bafc7ad56bb87";
// Refund with reference, a quote and a non-ASCII char in roundId.
const GOLDEN_REFUND =
	"ef7449dd44aa20935e653a27b28e5bbfdc7866f686da57d9aa82f5d0a60f3c7b";

describe("TST-U-06 payloadHash", () => {
	test("TST-U-06 matches the golden value of a known payload", () => {
		expect(payloadHash(base())).toBe(GOLDEN_BET);
	});

	test("TST-U-06 matches the golden value with reference, quote and non-ASCII", () => {
		expect(
			payloadHash({
				...base(),
				externalTransactionId: "ext-2",
				kind: Kind.Refund,
				roundId: 'round-é"',
				referenceExternalTransactionId: "ext-1",
			}),
		).toBe(GOLDEN_REFUND);
	});

	test("TST-U-06 is lowercase hex of 64 chars", () => {
		expect(payloadHash(base())).toMatch(/^[0-9a-f]{64}$/);
	});

	test("TST-U-06 does not depend on the insertion order of the input keys", () => {
		const a = base();
		const reordered: PayloadHashInput = {
			money: a.money,
			kind: a.kind,
			gameId: a.gameId,
			roundId: a.roundId,
			walletId: a.walletId,
			playerId: a.playerId,
			externalTransactionId: a.externalTransactionId,
			providerId: a.providerId,
		};
		expect(payloadHash(reordered)).toBe(payloadHash(a));
	});

	const mutations: Array<[string, Partial<PayloadHashInput>]> = [
		["providerId", { providerId: "prov-b" }],
		["externalTransactionId", { externalTransactionId: "ext-9" }],
		["playerId", { playerId: "0190a1b2-0000-7000-8000-0000000000ff" }],
		["walletId", { walletId: "0190a1b2-0000-7000-8000-0000000000ff" }],
		["roundId", { roundId: "round-2" }],
		["gameId", { gameId: "game-2" }],
		["kind", { kind: Kind.Win }],
		["amount", { money: Money.from({ amount: "25.01", currency: "BRL" }) }],
		["currency", { money: Money.from({ amount: "25.00", currency: "USD" }) }],
		[
			"referenceExternalTransactionId",
			{ referenceExternalTransactionId: "ext-0" },
		],
	];

	test.each(mutations)("TST-U-06 is sensitive to %s", (_field, change) => {
		expect(payloadHash({ ...base(), ...change })).not.toBe(payloadHash(base()));
	});

	test("TST-U-06 absent reference differs from present reference", () => {
		const without = payloadHash(base());
		const withRef = payloadHash({
			...base(),
			referenceExternalTransactionId: "x",
		});
		expect(withRef).not.toBe(without);
	});

	test("TST-U-06 an undefined reference hashes like an omitted one", () => {
		expect(
			payloadHash({ ...base(), referenceExternalTransactionId: undefined }),
		).toBe(payloadHash(base()));
	});

	test("TST-U-06 transport metadata is ignored (only the business subset is read)", () => {
		const noisy = {
			...base(),
			idempotencyKey: "other",
			messageId: "m-1",
			occurredAt: "2026-10-27T10:00:00Z",
			correlationId: "c-1",
		};
		expect(payloadHash(noisy)).toBe(payloadHash(base()));
	});

	test("TST-U-06 amount is normalized (01.00 hashes as 1.00)", () => {
		const a = {
			...base(),
			money: Money.from({ amount: "01.00", currency: "BRL" }),
		};
		const b = {
			...base(),
			money: Money.from({ amount: "1.00", currency: "BRL" }),
		};
		expect(payloadHash(a)).toBe(payloadHash(b));
	});
});

describe("TST-U-06 IdempotencyKey", () => {
	test("TST-U-06 accepts 1 to 255 printable ASCII chars", () => {
		expect(IdempotencyKey.from("a").value).toBe("a");
		expect(IdempotencyKey.from("a".repeat(255)).value).toHaveLength(255);
		expect(IdempotencyKey.from("prov:ext 1~!").value).toBe("prov:ext 1~!");
	});

	test.each([
		["empty", ""],
		["256 chars", "a".repeat(256)],
		["newline", "a\nb"],
		["tab", "a\tb"],
		["control char", "a\u0001"],
		["DEL", "a\u007f"],
		["non-ASCII", "chave-é"],
		["emoji", "k🎲"],
	])("TST-U-06 rejects %s", (_name, value) => {
		expect(() => IdempotencyKey.from(value)).toThrow(
			InvalidIdempotencyKeyError,
		);
	});

	test("TST-U-06 rejects non-strings at runtime", () => {
		expect(() => IdempotencyKey.from(42 as unknown as string)).toThrow(
			InvalidIdempotencyKeyError,
		);
		expect(() => IdempotencyKey.from(undefined as unknown as string)).toThrow(
			InvalidIdempotencyKeyError,
		);
	});

	test("TST-U-06 error is a DomainError with a stable code", () => {
		try {
			IdempotencyKey.from("");
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(DomainError);
			expect((error as DomainError).code).toBe("INVALID_IDEMPOTENCY_KEY");
		}
	});

	test("TST-U-06 default is {providerId}:{externalTransactionId}", () => {
		const key = IdempotencyKey.defaultFor("prov-a", "ext-1");
		expect(key.value).toBe("prov-a:ext-1");
		expect(key.toString()).toBe("prov-a:ext-1");
	});

	test("TST-U-06 default is validated too", () => {
		expect(() =>
			IdempotencyKey.defaultFor("p".repeat(200), "e".repeat(200)),
		).toThrow(InvalidIdempotencyKeyError);
		expect(() => IdempotencyKey.defaultFor("prov", "é")).toThrow(
			InvalidIdempotencyKeyError,
		);
	});
});
