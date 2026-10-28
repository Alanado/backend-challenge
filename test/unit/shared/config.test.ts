import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../../../src/shared/config";

const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db" };

describe("loadConfig", () => {
	test("CFG-01 applies the defaults of 02-design §8", () => {
		const config = loadConfig(base);
		expect(config.enableHttp).toBe(true);
		expect(config.enableConsumer).toBe(true);
		expect(config.enableOutboxPublisher).toBe(true);
		expect(config.enablePendingWorker).toBe(true);
		expect(config.dbPoolMax).toBe(10);
		expect(config.lockTimeoutMs).toBe(5000);
		expect(config.statementTimeoutMs).toBe(15000);
		expect(config.pendingRef).toEqual({
			maxAttempts: 6,
			baseMs: 5000,
			factor: 2,
			capMs: 300000,
			pollMs: 1000,
			concurrency: 5,
		});
		expect(config.outbox).toEqual({
			batch: 10,
			pollMs: 500,
			backoffBaseMs: 1000,
			backoffCapMs: 60000,
		});
		expect(config.sqs.maxReceive).toBe(8);
		expect(config.sqs.handlerTimeoutMs).toBe(20000);
		expect(config.sqs.concurrency).toBe(5);
		expect(config.sqs.backoffBaseS).toBe(2);
		expect(config.sqs.backoffCapS).toBe(30);
		expect(config.breaker).toEqual({
			cooldownMinMs: 1000,
			cooldownMaxMs: 30000,
		});
		expect(config.shutdownGraceMs).toBe(20000);
		expect(config.testFault).toBe("");
	});

	test("CFG-02 applies the defaults of the infrastructure variables", () => {
		const config = loadConfig(base);
		expect(config.nodeEnv).toBe("development");
		expect(config.port).toBe(3000);
		expect(config.logLevel).toBe("info");
		expect(config.sqs.region).toBe("us-east-1");
		expect(config.sqs.endpoint).toBe("http://localhost:4566");
		expect(config.sqs.accessKeyId).toBe("test");
		expect(config.sqs.secretAccessKey).toBe("test");
		expect(config.sqs.queueName).toBe("wager-transactions.fifo");
		expect(config.sqs.dlqName).toBe("wager-transactions-dlq.fifo");
		expect(config.sqs.eventsQueueName).toBe("wager-events.fifo");
		expect(config.sqs.queueUrl).toBeUndefined();
		expect(config.sqs.eventsQueueUrl).toBeUndefined();
	});

	test("CFG-03 coerces numbers and booleans that arrive as strings", () => {
		const config = loadConfig({
			...base,
			DB_POOL_MAX: "25",
			LOCK_TIMEOUT_MS: "250",
			PENDING_REF_FACTOR: "3",
			ENABLE_HTTP: "false",
			ENABLE_CONSUMER: "0",
			ENABLE_OUTBOX_PUBLISHER: "TRUE",
			ENABLE_PENDING_WORKER: "1",
			PORT: "3002",
		});
		expect(config.dbPoolMax).toBe(25);
		expect(config.lockTimeoutMs).toBe(250);
		expect(config.pendingRef.factor).toBe(3);
		expect(config.enableHttp).toBe(false);
		expect(config.enableConsumer).toBe(false);
		expect(config.enableOutboxPublisher).toBe(true);
		expect(config.enablePendingWorker).toBe(true);
		expect(config.port).toBe(3002);
	});

	test("CFG-04 treats an empty string as the default", () => {
		const config = loadConfig({ ...base, DB_POOL_MAX: "", ENABLE_HTTP: "" });
		expect(config.dbPoolMax).toBe(10);
		expect(config.enableHttp).toBe(true);
	});

	test("CFG-05 rejects a missing DATABASE_URL naming the variable", () => {
		expect(() => loadConfig({})).toThrow(ConfigError);
		expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
	});

	test.each([
		["DB_POOL_MAX", "abc"],
		["DB_POOL_MAX", "0"],
		["DB_POOL_MAX", "1.5"],
		["LOCK_TIMEOUT_MS", "-1"],
		["ENABLE_HTTP", "maybe"],
		["PORT", "70000"],
		["NODE_ENV", "staging"],
		["LOG_LEVEL", "loud"],
		["PENDING_REF_FACTOR", "0"],
	])("CFG-06 rejects invalid %s=%s with a readable message", (name, value) => {
		let error: unknown;
		try {
			loadConfig({ ...base, [name]: value });
		} catch (err) {
			error = err;
		}
		expect(error).toBeInstanceOf(ConfigError);
		expect((error as ConfigError).message).toContain(name);
		expect((error as ConfigError).issues.map((i) => i.variable)).toContain(
			name,
		);
	});

	test("CFG-07 reports every invalid variable at once", () => {
		let error: ConfigError | undefined;
		try {
			loadConfig({ DB_POOL_MAX: "x", PORT: "y" });
		} catch (err) {
			error = err as ConfigError;
		}
		expect(error?.issues.map((i) => i.variable).sort()).toEqual([
			"DATABASE_URL",
			"DB_POOL_MAX",
			"PORT",
		]);
	});

	test("CFG-08 rejects a breaker cooldown whose min exceeds the max", () => {
		expect(() =>
			loadConfig({
				...base,
				BREAKER_COOLDOWN_MIN_MS: "5000",
				BREAKER_COOLDOWN_MAX_MS: "1000",
			}),
		).toThrow(/BREAKER_COOLDOWN_MIN_MS/);
	});

	test("CFG-09 does not read process.env (pure function of its argument)", () => {
		process.env.DB_POOL_MAX = "99";
		try {
			expect(loadConfig(base).dbPoolMax).toBe(10);
		} finally {
			delete process.env.DB_POOL_MAX;
		}
	});
});
