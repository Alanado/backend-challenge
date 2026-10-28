import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { uniqueId } from "../support/ids";
import {
	CHECK_VIOLATION,
	connect,
	failureOf,
	NOT_NULL_VIOLATION,
	UNIQUE_VIOLATION,
} from "../support/sql";
import {
	createSuiteDatabase,
	type SuiteDatabase,
} from "../support/suite-database";

let db: SuiteDatabase;
let client: Client;

beforeAll(async () => {
	db = await createSuiteDatabase();
	client = await connect(db.url);
});

afterAll(async () => {
	await client.end();
	await db.drop();
});

function insertInbox(consumer: string, messageId: string) {
	return client.query(
		"insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values ($1, $2, 'hash', now()) returning *",
		[consumer, messageId],
	);
}

function insertOutbox(overrides: Record<string, unknown> = {}) {
	const row = {
		id: uniqueId(),
		aggregate_id: uniqueId(),
		group_key: uniqueId(),
		event_type: "wager.transaction.processed",
		payload: { eventId: "x", amount: "10.00" },
		occurred_at: new Date(),
		next_attempt_at: new Date(),
		...overrides,
	};
	const columns = Object.keys(row);
	return client.query(
		`insert into outbox_messages (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
		columns.map((c) => {
			const v = (row as Record<string, unknown>)[c];
			return c === "payload" ? JSON.stringify(v) : v;
		}),
	);
}

describe("TST-I-02 inbox_messages (raw SQL)", () => {
	test("TST-I-02 inbox: PK (consumer_name, message_id) rejects a duplicate", async () => {
		const messageId = `msg-${uniqueId()}`;
		await insertInbox("wager-consumer", messageId);
		const failure = await failureOf(insertInbox("wager-consumer", messageId));
		expect(failure.code).toBe(UNIQUE_VIOLATION);
		expect(failure.constraint).toBe("inbox_messages_pkey");
	});

	test("TST-I-02 inbox: the same message id is accepted for another consumer", async () => {
		const messageId = `msg-${uniqueId()}`;
		await insertInbox("consumer-a", messageId);
		const other = await insertInbox("consumer-b", messageId);
		expect(other.rows[0].consumer_name).toBe("consumer-b");
	});

	test("TST-I-02 inbox: ON CONFLICT DO NOTHING is the dedup primitive (0 rows on a duplicate)", async () => {
		const messageId = `msg-${uniqueId()}`;
		const sql =
			"insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values ('c', $1, 'h', now()) on conflict do nothing";
		expect((await client.query(sql, [messageId])).rowCount).toBe(1);
		expect((await client.query(sql, [messageId])).rowCount).toBe(0);
	});

	test("TST-I-02 inbox: processed_at starts NULL and payload_hash is required", async () => {
		const res = await insertInbox("c", `msg-${uniqueId()}`);
		expect(res.rows[0].processed_at).toBeNull();
		const failure = await failureOf(
			client.query(
				"insert into inbox_messages (consumer_name, message_id, received_at) values ('c', $1, now())",
				[`msg-${uniqueId()}`],
			),
		);
		expect(failure.code).toBe(NOT_NULL_VIOLATION);
	});
});

describe("TST-I-02 outbox_messages (raw SQL)", () => {
	test("TST-I-02 outbox: a new row defaults attempts to 0 and has no final state", async () => {
		const res = await insertOutbox();
		expect(res.rows[0].attempts).toBe(0);
		expect(res.rows[0].published_at).toBeNull();
		expect(res.rows[0].failed_at).toBeNull();
		expect(res.rows[0].payload).toEqual({ eventId: "x", amount: "10.00" });
	});

	test("TST-I-02 ob_final_exclusive: published_at and failed_at cannot both be set", async () => {
		const failure = await failureOf(
			insertOutbox({ published_at: new Date(), failed_at: new Date() }),
		);
		expect(failure.code).toBe(CHECK_VIOLATION);
		expect(failure.constraint).toBe("ob_final_exclusive");
	});

	test("TST-I-02 ob_final_exclusive also guards UPDATE", async () => {
		const row = (await insertOutbox({ published_at: new Date() })).rows[0];
		const failure = await failureOf(
			client.query(
				"update outbox_messages set failed_at = now() where id = $1",
				[row.id],
			),
		);
		expect(failure.constraint).toBe("ob_final_exclusive");
	});

	test("TST-I-02 outbox: published_at alone, or failed_at alone, is accepted", async () => {
		expect(
			(await insertOutbox({ published_at: new Date() })).rows[0].published_at,
		).not.toBeNull();
		expect(
			(await insertOutbox({ failed_at: new Date(), last_error: "boom" }))
				.rows[0].failed_at,
		).not.toBeNull();
	});

	test("TST-I-02 outbox: the primary key (event id) rejects a republished duplicate", async () => {
		const id = uniqueId();
		await insertOutbox({ id });
		const failure = await failureOf(insertOutbox({ id }));
		expect(failure.code).toBe(UNIQUE_VIOLATION);
		expect(failure.constraint).toBe("outbox_messages_pkey");
	});

	test("TST-I-02 outbox: payload must be jsonb and NOT NULL", async () => {
		const failure = await failureOf(
			client.query(
				"insert into outbox_messages (id, aggregate_id, group_key, event_type, payload, occurred_at, next_attempt_at) values ($1, 'a', 'g', 't', null, now(), now())",
				[uniqueId()],
			),
		);
		expect(failure.code).toBe(NOT_NULL_VIOLATION);
		const type = await client.query(
			"select data_type from information_schema.columns where table_name = 'outbox_messages' and column_name = 'payload'",
		);
		expect(type.rows[0].data_type).toBe("jsonb");
	});

	test("TST-I-02 ob_publishable is a partial index over unpublished, unfailed rows", async () => {
		const res = await client.query(
			"select indexdef from pg_indexes where indexname = 'ob_publishable'",
		);
		const def = res.rows[0].indexdef as string;
		expect(def).toContain("(occurred_at)");
		expect(def).toContain("published_at IS NULL");
		expect(def).toContain("failed_at IS NULL");
	});

	test("TST-I-02 ob_publishable serves the publisher query (planner uses it)", async () => {
		// Fresh transaction-local setting so the tiny test table still shows the index choice.
		await client.query("begin");
		try {
			await client.query("set local enable_seqscan = off");
			const plan = await client.query(
				"explain select id from outbox_messages where published_at is null and failed_at is null order by occurred_at limit 10",
			);
			const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
			expect(text).toContain("ob_publishable");
		} finally {
			await client.query("rollback");
		}
	});
});
