import { afterAll, describe, expect, test } from "bun:test";
import {
	GetQueueAttributesCommand,
	GetQueueUrlCommand,
	QueueDoesNotExist,
	SQSClient,
} from "@aws-sdk/client-sqs";
import { Client } from "pg";
import { uniqueId } from "../support/ids";
import { testInfra } from "../support/infra";
import {
	createSuiteDatabase,
	type SuiteDatabase,
} from "../support/suite-database";
import { createSuiteQueues } from "../support/suite-queues";

async function withClient<T>(
	url: string,
	work: (client: Client) => Promise<T>,
): Promise<T> {
	const client = new Client({ connectionString: url });
	await client.connect();
	try {
		return await work(client);
	} finally {
		await client.end();
	}
}

async function databaseExists(name: string): Promise<boolean> {
	return withClient(testInfra.databaseUrl, async (client) => {
		const res = await client.query(
			"select 1 from pg_database where datname = $1",
			[name],
		);
		return res.rowCount === 1;
	});
}

describe("createSuiteDatabase (PostgreSQL real)", () => {
	const created: SuiteDatabase[] = [];
	afterAll(async () => {
		await Promise.all(created.map((db) => db.drop()));
	});

	test("X-10 two suite databases are isolated from each other and from the template", async () => {
		const a = await createSuiteDatabase();
		const b = await createSuiteDatabase();
		created.push(a, b);
		expect(a.name).not.toBe(b.name);
		expect(a.url).not.toBe(b.url);

		const marker = uniqueId();
		await withClient(a.url, async (client) => {
			await client.query("create table isolation_probe (id text primary key)");
			await client.query("insert into isolation_probe values ($1)", [marker]);
		});

		await withClient(b.url, async (client) => {
			const res = await client.query(
				"select to_regclass('public.isolation_probe') as probe",
			);
			expect(res.rows[0].probe).toBeNull();
		});
		await withClient(a.templateUrl, async (client) => {
			const res = await client.query(
				"select to_regclass('public.isolation_probe') as probe",
			);
			expect(res.rows[0].probe).toBeNull();
		});
	});

	test("X-11 leaves no connection open on the template", async () => {
		const db = await createSuiteDatabase();
		created.push(db);
		const open = await withClient(testInfra.databaseUrl, async (client) => {
			const res = await client.query(
				"select count(*)::int as n from pg_stat_activity where datname = $1",
				[db.templateName],
			);
			return res.rows[0].n as number;
		});
		expect(open).toBe(0);
	});

	test("X-12 fails loudly when a connection is open on the template", async () => {
		const first = await createSuiteDatabase();
		created.push(first);
		const squatter = new Client({ connectionString: first.templateUrl });
		await squatter.connect();
		try {
			await expect(createSuiteDatabase()).rejects.toThrow(
				/open connection.*template/i,
			);
		} finally {
			await squatter.end();
		}
	});

	test("X-13 creates many suite databases concurrently", async () => {
		const dbs = await Promise.all(
			Array.from({ length: 6 }, () => createSuiteDatabase()),
		);
		created.push(...dbs);
		expect(new Set(dbs.map((d) => d.name)).size).toBe(6);
		for (const db of dbs) expect(await databaseExists(db.name)).toBe(true);
	});

	test("X-14 drop removes the database even with a live connection", async () => {
		const db = await createSuiteDatabase();
		const live = new Client({ connectionString: db.url });
		await live.connect();
		live.on("error", () => {});
		await db.drop();
		expect(await databaseExists(db.name)).toBe(false);
	});

	test("X-15 an unmigrated database can be requested", async () => {
		const db = await createSuiteDatabase({ migrated: false });
		created.push(db);
		await withClient(db.url, async (client) => {
			const res = await client.query(
				"select to_regclass('public.wallets') as wallets",
			);
			expect(res.rows[0].wallets).toBeNull();
		});
	});
});

describe("createSuiteQueues (SQS real)", () => {
	const sqs = new SQSClient({
		region: testInfra.region,
		endpoint: testInfra.sqsEndpoint,
		credentials: testInfra.credentials,
	});

	test("X-16 creates main, DLQ and events FIFO queues with a correct redrive policy", async () => {
		const queues = await createSuiteQueues("suite");
		try {
			const main = await sqs.send(
				new GetQueueAttributesCommand({
					QueueUrl: queues.main.url,
					AttributeNames: ["All"],
				}),
			);
			const dlq = await sqs.send(
				new GetQueueAttributesCommand({
					QueueUrl: queues.dlq.url,
					AttributeNames: ["All"],
				}),
			);
			const events = await sqs.send(
				new GetQueueAttributesCommand({
					QueueUrl: queues.events.url,
					AttributeNames: ["All"],
				}),
			);
			for (const attrs of [main, dlq, events]) {
				expect(attrs.Attributes?.FifoQueue).toBe("true");
			}
			const redrive = JSON.parse(main.Attributes?.RedrivePolicy ?? "{}");
			expect(redrive.maxReceiveCount).toBe(8);
			expect(redrive.deadLetterTargetArn).toBe(dlq.Attributes?.QueueArn);
			expect(dlq.Attributes?.RedrivePolicy).toBeUndefined();
			expect(events.Attributes?.RedrivePolicy).toBeUndefined();
			expect(main.Attributes?.VisibilityTimeout).toBe("30");
			expect(queues.main.name).toStartWith("suite-");
			expect(queues.main.name).toEndWith(".fifo");
		} finally {
			await queues.destroy();
		}
	});

	test("X-17 two suites get distinct random suffixes and names", async () => {
		const [a, b] = await Promise.all([
			createSuiteQueues("suite"),
			createSuiteQueues("suite"),
		]);
		try {
			expect(a.suffix).not.toBe(b.suffix);
			expect(a.main.name).not.toBe(b.main.name);
			expect(a.main.url).not.toBe(b.main.url);
			expect(a.dlq.name).not.toBe(b.dlq.name);
		} finally {
			await Promise.all([a.destroy(), b.destroy()]);
		}
	});

	test("X-18 honors a custom maxReceiveCount", async () => {
		const queues = await createSuiteQueues("suite", { maxReceiveCount: 2 });
		try {
			const main = await sqs.send(
				new GetQueueAttributesCommand({
					QueueUrl: queues.main.url,
					AttributeNames: ["RedrivePolicy"],
				}),
			);
			expect(
				JSON.parse(main.Attributes?.RedrivePolicy ?? "{}").maxReceiveCount,
			).toBe(2);
		} finally {
			await queues.destroy();
		}
	});

	test("X-19 destroy deletes the three queues", async () => {
		const queues = await createSuiteQueues("suite");
		await queues.destroy();
		for (const name of [
			queues.main.name,
			queues.dlq.name,
			queues.events.name,
		]) {
			await expect(
				sqs.send(new GetQueueUrlCommand({ QueueName: name })),
			).rejects.toBeInstanceOf(QueueDoesNotExist);
		}
	});
});

describe("uniqueId", () => {
	test("X-26 returns distinct UUIDv7 values", () => {
		const ids = Array.from({ length: 50 }, () => uniqueId());
		expect(new Set(ids).size).toBe(50);
		for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{8}-[0-9a-f-]{4}-7/);
	});
});
