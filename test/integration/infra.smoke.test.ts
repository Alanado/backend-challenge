import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	GetQueueAttributesCommand,
	GetQueueUrlCommand,
	SQSClient,
} from "@aws-sdk/client-sqs";
import { Client } from "pg";
import { testInfra } from "../support/infra";

const sqs = new SQSClient({
	region: testInfra.region,
	endpoint: testInfra.sqsEndpoint,
	credentials: testInfra.credentials,
});
const pg = new Client({ connectionString: testInfra.databaseUrl });

async function queueAttributes(name: string): Promise<Record<string, string>> {
	const { QueueUrl } = await sqs.send(
		new GetQueueUrlCommand({ QueueName: name }),
	);
	const out = await sqs.send(
		new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["All"] }),
	);
	return out.Attributes ?? {};
}

describe("infra smoke (Postgres e SQS reais)", () => {
	beforeAll(async () => {
		await pg.connect();
	});
	afterAll(async () => {
		await pg.end();
	});

	test("INFRA-01 postgres answers SELECT 1 and allows many connections", async () => {
		const one = await pg.query("select 1 as one");
		expect(one.rows[0].one).toBe(1);
		const max = await pg.query("show max_connections");
		expect(Number(max.rows[0].max_connections)).toBeGreaterThanOrEqual(200);
	});

	test("INFRA-02 the three queues exist as FIFO queues", async () => {
		for (const name of [
			"wager-transactions.fifo",
			"wager-transactions-dlq.fifo",
			"wager-events.fifo",
		]) {
			const attrs = await queueAttributes(name);
			expect(attrs.FifoQueue).toBe("true");
		}
	});

	test("INFRA-03 main queue has visibility 30s and long polling 20s", async () => {
		const attrs = await queueAttributes("wager-transactions.fifo");
		expect(attrs.VisibilityTimeout).toBe("30");
		expect(attrs.ReceiveMessageWaitTimeSeconds).toBe("20");
	});

	test("INFRA-04 main queue redrives to the DLQ after 8 receives", async () => {
		const main = await queueAttributes("wager-transactions.fifo");
		const dlq = await queueAttributes("wager-transactions-dlq.fifo");
		const policy = JSON.parse(main.RedrivePolicy ?? "{}") as {
			deadLetterTargetArn?: string;
			maxReceiveCount?: number;
		};
		expect(Number(policy.maxReceiveCount)).toBe(8);
		expect(policy.deadLetterTargetArn).toBe(dlq.QueueArn);
	});

	test("INFRA-05 create-queues is idempotent: second run changes nothing", async () => {
		const run = async (): Promise<{ code: number; out: string }> => {
			const proc = Bun.spawn(["bun", "run", "scripts/create-queues.ts"], {
				env: { ...process.env, SQS_ENDPOINT: testInfra.sqsEndpoint },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, err, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			return { code, out: out + err };
		};
		const first = await run();
		const second = await run();
		expect(first.code).toBe(0);
		expect(second.code).toBe(0);
		expect(second.out).not.toContain("created");
		expect(second.out).not.toContain("updated");
		expect(second.out.match(/unchanged/g)?.length).toBe(3);
	});
});
