import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type AppProcess, freePort, spawnApp } from "../support/app-process";
import { eventually } from "../support/eventually";
import {
	createSuiteDatabase,
	type SuiteDatabase,
} from "../support/suite-database";

let db: SuiteDatabase;
let app: AppProcess;
let base: string;

beforeAll(async () => {
	db = await createSuiteDatabase();
	const port = await freePort();
	base = `http://127.0.0.1:${port}`;
	app = spawnApp({ DATABASE_URL: db.url, PORT: String(port) });
	await app.waitForStdout("app_started");
});

afterAll(async () => {
	await app.stop();
	await db.drop();
});

function jsonLines(text: string): Record<string, unknown>[] {
	return text
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const accessLogOf = (correlationId: string) =>
	jsonLines(app.stdout()).find(
		(line) =>
			line.msg === "request completed" && line.correlationId === correlationId,
	);

/** The request log shows up shortly after the response; waits for it. */
const waitForAccessLog = (correlationId: string) =>
	eventually(() => accessLogOf(correlationId) ?? false);

describe("TST-I-17 logs carry the required fields (HTTP, real process)", () => {
	test("TST-I-17 a supplied X-Correlation-Id is echoed and appears in the request log", async () => {
		const response = await fetch(`${base}/nothing`, {
			headers: { "X-Correlation-Id": "corr-from-client-1" },
		});

		expect(response.status).toBe(404);
		expect(response.headers.get("x-correlation-id")).toBe("corr-from-client-1");
		const line = await waitForAccessLog("corr-from-client-1");
		expect(line).toMatchObject({
			msg: "request completed",
			correlationId: "corr-from-client-1",
			channel: "http",
			status: 404,
		});
		expect(typeof line.durationMs).toBe("number");
	});

	test("TST-I-17 without the header a UUIDv7 is generated, returned and logged", async () => {
		const response = await fetch(`${base}/nothing`);

		const generated = response.headers.get("x-correlation-id") ?? "";
		expect(generated).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		const line = await waitForAccessLog(generated);
		expect(line.correlationId).toBe(generated);
	});

	test("TST-I-17 an unusable X-Correlation-Id is replaced, not echoed", async () => {
		const response = await fetch(`${base}/nothing`, {
			headers: { "X-Correlation-Id": "x".repeat(300) },
		});

		const returned = response.headers.get("x-correlation-id") ?? "";
		expect(returned).not.toContain("xxxx");
		expect(returned).toHaveLength(36);
	});

	test("TST-I-17 request logs never carry path, query, body or forbidden keys", async () => {
		const secretPlayer = "0192f298-aaaa-7bbb-8ccc-secretplayer1";
		const response = await fetch(`${base}/nothing?playerId=${secretPlayer}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Correlation-Id": "corr-no-leak",
			},
			body: JSON.stringify({ amount: "7771234.56", playerId: secretPlayer }),
		});
		await response.text();

		await waitForAccessLog("corr-no-leak");
		expect(app.stdout()).not.toContain(secretPlayer);
		expect(app.stdout()).not.toContain("7771234.56");
		const line = accessLogOf("corr-no-leak") ?? {};
		for (const key of ["req", "res", "url", "body", "playerId", "amount"]) {
			expect(line).not.toHaveProperty(key);
		}
	});
});
