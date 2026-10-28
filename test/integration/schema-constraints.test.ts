import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { uniqueId } from "../support/ids";
import {
	CHECK_VIOLATION,
	connect,
	FK_VIOLATION,
	failureOf,
	insertTransaction,
	insertWallet,
	UNIQUE_VIOLATION,
} from "../support/sql";
import {
	createSuiteDatabase,
	type SuiteDatabase,
} from "../support/suite-database";

let db: SuiteDatabase;
let client: Client;
let walletId: string;

beforeAll(async () => {
	db = await createSuiteDatabase();
	client = await connect(db.url);
});

afterAll(async () => {
	await client.end();
	await db.drop();
});

// A fresh wallet per test keeps every case independent (unique ids instead of cleanup).
async function freshWallet(overrides = {}): Promise<string> {
	return (await insertWallet(client, overrides)).id as string;
}

describe("TST-I-02 wallets constraints (raw SQL)", () => {
	test("TST-I-02 wallets: UNIQUE (player_id, currency) rejects a second wallet for the same player and currency", async () => {
		const playerId = uniqueId();
		await insertWallet(client, { player_id: playerId, currency: "BRL" });
		const failure = await failureOf(
			insertWallet(client, { player_id: playerId, currency: "BRL" }),
		);
		expect(failure.code).toBe(UNIQUE_VIOLATION);
		expect(failure.constraint).toBe("wallets_player_currency_uk");
	});

	test("TST-I-02 wallets: the same player may hold wallets in different currencies", async () => {
		const playerId = uniqueId();
		await insertWallet(client, { player_id: playerId, currency: "BRL" });
		const other = await insertWallet(client, {
			player_id: playerId,
			currency: "USD",
		});
		expect(other.currency).toBe("USD");
	});

	test("TST-I-02 wallets: CHECK balance >= 0 rejects a negative balance", async () => {
		const failure = await failureOf(insertWallet(client, { balance: "-0.01" }));
		expect(failure.code).toBe(CHECK_VIOLATION);
		expect(failure.constraint).toBe("wallets_balance_non_negative");
	});

	test("TST-I-02 wallets: CHECK balance >= 0 allows exactly zero", async () => {
		const wallet = await insertWallet(client, { balance: "0.00" });
		expect(wallet.balance).toBe("0.00");
	});

	test("TST-I-02 wallets: CHECK balance >= 0 also guards UPDATE", async () => {
		const id = await freshWallet({ balance: "5.00" });
		const failure = await failureOf(
			client.query("update wallets set balance = '-1.00' where id = $1", [id]),
		);
		expect(failure.constraint).toBe("wallets_balance_non_negative");
	});

	test("TST-I-02 wallets: CHECK version >= 1 rejects zero", async () => {
		const failure = await failureOf(insertWallet(client, { version: 0 }));
		expect(failure.code).toBe(CHECK_VIOLATION);
		expect(failure.constraint).toBe("wallets_version_positive");
	});

	test("TST-I-02 wallets: CHECK currency format rejects lowercase and wrong length", async () => {
		for (const currency of ["brl", "BR", "BRLL", "B1L"]) {
			const failure = await failureOf(insertWallet(client, { currency }));
			expect(failure.code).toBe(CHECK_VIOLATION);
			expect(failure.constraint).toBe("wallets_currency_check");
		}
	});

	test("TST-I-02 wallets: numeric(19,2) keeps 17 integer digits exactly", async () => {
		const wallet = await insertWallet(client, {
			balance: "12345678901234567.89",
		});
		expect(wallet.balance).toBe("12345678901234567.89");
	});
});

describe("TST-I-02 wager_transactions constraints (raw SQL)", () => {
	beforeAll(async () => {
		walletId = await freshWallet();
	});

	test("TST-I-02 wt: UNIQUE (provider_id, idempotency_key) rejects a repeated key for the same provider", async () => {
		const key = `idem-${uniqueId()}`;
		await insertTransaction(client, walletId, { idempotency_key: key });
		const failure = await failureOf(
			insertTransaction(client, walletId, { idempotency_key: key }),
		);
		expect(failure.code).toBe(UNIQUE_VIOLATION);
		expect(failure.constraint).toBe("wt_idempotency_uk");
	});

	test("TST-I-02 wt: the same idempotency key is allowed for another provider", async () => {
		const key = `idem-${uniqueId()}`;
		await insertTransaction(client, walletId, {
			idempotency_key: key,
			provider_id: "provider-a",
		});
		const other = await insertTransaction(client, walletId, {
			idempotency_key: key,
			provider_id: "provider-b",
		});
		expect(other.provider_id).toBe("provider-b");
	});

	test("TST-I-02 wt: UNIQUE (provider_id, external_transaction_id) rejects a repeated external id", async () => {
		const ext = `ext-${uniqueId()}`;
		await insertTransaction(client, walletId, {
			external_transaction_id: ext,
		});
		const failure = await failureOf(
			insertTransaction(client, walletId, { external_transaction_id: ext }),
		);
		expect(failure.code).toBe(UNIQUE_VIOLATION);
		expect(failure.constraint).toBe("wt_external_id_uk");
	});

	test("TST-I-02 wt: the same external id is allowed for another provider", async () => {
		const ext = `ext-${uniqueId()}`;
		await insertTransaction(client, walletId, {
			external_transaction_id: ext,
			provider_id: "provider-a",
		});
		const other = await insertTransaction(client, walletId, {
			external_transaction_id: ext,
			provider_id: "provider-b",
		});
		expect(other.provider_id).toBe("provider-b");
	});

	test("TST-I-02 wt: CHECK amount > 0 rejects zero and negatives", async () => {
		for (const amount of ["0.00", "-1.00"]) {
			const failure = await failureOf(
				insertTransaction(client, walletId, { amount }),
			);
			expect(failure.code).toBe(CHECK_VIOLATION);
			expect(failure.constraint).toBe("wager_transactions_amount_check");
		}
	});

	test("TST-I-02 wt: CHECK kind and status reject values outside the enums", async () => {
		const kind = await failureOf(
			insertTransaction(client, walletId, { kind: "DEPOSIT" }),
		);
		expect(kind.constraint).toBe("wager_transactions_kind_check");
		const status = await failureOf(
			insertTransaction(client, walletId, { status: "DONE" }),
		);
		expect(status.constraint).toBe("wager_transactions_status_check");
	});

	test("TST-I-02 wt: CHECK currency format rejects a malformed currency", async () => {
		const failure = await failureOf(
			insertTransaction(client, walletId, { currency: "brl" }),
		);
		expect(failure.constraint).toBe("wager_transactions_currency_check");
	});

	test("TST-I-02 wt_ref_required: REFUND and ROLLBACK need a reference", async () => {
		for (const kind of ["REFUND", "ROLLBACK"]) {
			const failure = await failureOf(
				insertTransaction(client, walletId, {
					kind,
					reference_external_transaction_id: null,
				}),
			);
			expect(failure.code).toBe(CHECK_VIOLATION);
			expect(failure.constraint).toBe("wt_ref_required");
		}
	});

	test("TST-I-02 wt_ref_required: REFUND with a reference is accepted", async () => {
		const row = await insertTransaction(client, walletId, {
			kind: "REFUND",
			reference_external_transaction_id: "some-ext",
		});
		expect(row.kind).toBe("REFUND");
	});

	test("TST-I-02 wt_ref_forbidden: BET and OPENING cannot carry a reference", async () => {
		for (const kind of ["BET", "OPENING"]) {
			const failure = await failureOf(
				insertTransaction(client, walletId, {
					kind,
					reference_external_transaction_id: "some-ext",
				}),
			);
			expect(failure.code).toBe(CHECK_VIOLATION);
			expect(failure.constraint).toBe("wt_ref_forbidden");
		}
	});

	test("TST-I-02 wt_failure_code: REJECTED and FAILED need a failure_code, other states forbid it", async () => {
		for (const status of ["REJECTED", "FAILED"]) {
			const failure = await failureOf(
				insertTransaction(client, walletId, { status, failure_code: null }),
			);
			expect(failure.constraint).toBe("wt_failure_code");
		}
		const processed = await failureOf(
			insertTransaction(client, walletId, {
				status: "PROCESSED",
				processed_at: new Date(),
				failure_code: "INSUFFICIENT_FUNDS",
			}),
		);
		expect(processed.constraint).toBe("wt_failure_code");
		const pending = await failureOf(
			insertTransaction(client, walletId, {
				status: "PENDING",
				failure_code: "INSUFFICIENT_FUNDS",
			}),
		);
		expect(pending.constraint).toBe("wt_failure_code");
	});

	test("TST-I-02 wt_failure_code: a REJECTED row with a failure_code is accepted", async () => {
		const row = await insertTransaction(client, walletId, {
			status: "REJECTED",
			failure_code: "INSUFFICIENT_FUNDS",
		});
		expect(row.status).toBe("REJECTED");
	});

	test("TST-I-02 wt_processed_at: PROCESSED needs processed_at and no other state may have it", async () => {
		const missing = await failureOf(
			insertTransaction(client, walletId, {
				status: "PROCESSED",
				processed_at: null,
			}),
		);
		expect(missing.code).toBe(CHECK_VIOLATION);
		expect(missing.constraint).toBe("wt_processed_at");
		const extra = await failureOf(
			insertTransaction(client, walletId, {
				status: "PENDING",
				processed_at: new Date(),
			}),
		);
		expect(extra.constraint).toBe("wt_processed_at");
	});

	test("TST-I-02 wt_pending_ref: PENDING_REFERENCE needs next_attempt_at", async () => {
		const failure = await failureOf(
			insertTransaction(client, walletId, {
				kind: "REFUND",
				reference_external_transaction_id: "ext-x",
				status: "PENDING_REFERENCE",
				next_attempt_at: null,
			}),
		);
		expect(failure.code).toBe(CHECK_VIOLATION);
		expect(failure.constraint).toBe("wt_pending_ref");
		const ok = await insertTransaction(client, walletId, {
			kind: "REFUND",
			reference_external_transaction_id: "ext-x",
			status: "PENDING_REFERENCE",
			next_attempt_at: new Date(),
		});
		expect(ok.status).toBe("PENDING_REFERENCE");
	});

	test("TST-I-02 wt FK: wallet_id must reference an existing wallet", async () => {
		const failure = await failureOf(insertTransaction(client, uniqueId()));
		expect(failure.code).toBe(FK_VIOLATION);
		expect(failure.constraint).toBe("wager_transactions_wallet_id_fkey");
	});

	test("TST-I-02 wt FK: reference_transaction_id must reference an existing transaction", async () => {
		const failure = await failureOf(
			insertTransaction(client, walletId, {
				kind: "REFUND",
				reference_external_transaction_id: "ext-y",
				reference_transaction_id: uniqueId(),
			}),
		);
		expect(failure.code).toBe(FK_VIOLATION);
		expect(failure.constraint).toBe(
			"wager_transactions_reference_transaction_id_fkey",
		);
	});

	test("TST-I-02 wt FK: a wallet with transactions cannot be deleted", async () => {
		const id = await freshWallet();
		await insertTransaction(client, id);
		const failure = await failureOf(
			client.query("delete from wallets where id = $1", [id]),
		);
		expect(failure.code).toBe(FK_VIOLATION);
	});
});

describe("TST-I-02 wt_one_reversal_per_reference (partial unique index)", () => {
	async function original(): Promise<{ wallet: string; id: string }> {
		const wallet = await freshWallet();
		const bet = await insertTransaction(client, wallet, {
			status: "PROCESSED",
			processed_at: new Date(),
		});
		return { wallet, id: bet.id as string };
	}

	function reversal(
		wallet: string,
		referenceId: string,
		overrides: Record<string, unknown> = {},
	) {
		return insertTransaction(client, wallet, {
			kind: "REFUND",
			reference_external_transaction_id: "ext-ref",
			reference_transaction_id: referenceId,
			status: "PROCESSED",
			processed_at: new Date(),
			...overrides,
		});
	}

	test("TST-I-02 two PROCESSED reversals of the same reference violate the index", async () => {
		const { wallet, id } = await original();
		await reversal(wallet, id);
		const failure = await failureOf(reversal(wallet, id));
		expect(failure.code).toBe(UNIQUE_VIOLATION);
		expect(failure.constraint).toBe("wt_one_reversal_per_reference");
	});

	test("TST-I-02 a REFUND and a ROLLBACK PROCESSED for the same reference also violate it", async () => {
		const { wallet, id } = await original();
		await reversal(wallet, id, { kind: "REFUND" });
		const failure = await failureOf(reversal(wallet, id, { kind: "ROLLBACK" }));
		expect(failure.constraint).toBe("wt_one_reversal_per_reference");
	});

	test("TST-I-02 one REJECTED plus one PROCESSED reversal of the same reference is allowed", async () => {
		const { wallet, id } = await original();
		await reversal(wallet, id, {
			status: "REJECTED",
			processed_at: null,
			failure_code: "REFERENCE_ALREADY_REVERSED",
		});
		const processed = await reversal(wallet, id);
		expect(processed.status).toBe("PROCESSED");
	});

	test("TST-I-02 PROCESSED reversals of different references are allowed", async () => {
		const first = await original();
		const second = await original();
		await reversal(first.wallet, first.id);
		const other = await reversal(second.wallet, second.id);
		expect(other.status).toBe("PROCESSED");
	});

	test("TST-I-02 the partial index and the two pending indexes exist with their predicates", async () => {
		const res = await client.query(
			"select indexname, indexdef from pg_indexes where tablename = 'wager_transactions' and indexname in ('wt_one_reversal_per_reference','wt_pending_due','wt_pending_by_ref')",
		);
		const defs = new Map(
			res.rows.map((r) => [r.indexname as string, r.indexdef as string]),
		);
		expect(defs.get("wt_one_reversal_per_reference")).toContain("UNIQUE");
		expect(defs.get("wt_one_reversal_per_reference")).toContain(
			"(reference_transaction_id)",
		);
		expect(defs.get("wt_pending_due")).toContain("(next_attempt_at)");
		expect(defs.get("wt_pending_due")).toContain("PENDING_REFERENCE");
		expect(defs.get("wt_pending_by_ref")).toContain(
			"(provider_id, reference_external_transaction_id, wallet_id)",
		);
		expect(defs.get("wt_pending_by_ref")).toContain("PENDING_REFERENCE");
	});
});
