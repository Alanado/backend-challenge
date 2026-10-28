import { z } from "zod";
import { FAULT_POINTS, type FaultPoint } from "./fault-injector";

export interface ConfigIssue {
	variable: string;
	problem: string;
}

export class ConfigError extends Error {
	readonly issues: readonly ConfigIssue[];

	constructor(issues: readonly ConfigIssue[]) {
		super(
			`invalid configuration:\n${issues.map((i) => `  - ${i.variable}: ${i.problem}`).join("\n")}`,
		);
		this.name = "ConfigError";
		this.issues = issues;
	}
}

type Env = Readonly<Record<string, string | undefined>>;

// Empty strings count as "not set", so `FOO=` in a .env file falls back to the default.
const blankToUndefined = (value: unknown) => (value === "" ? undefined : value);

const int = (fallback: number, min = 0) =>
	z.preprocess(
		blankToUndefined,
		z.coerce.number().int().min(min).default(fallback),
	);

const text = (fallback: string) =>
	z.preprocess(blankToUndefined, z.string().default(fallback));

const flag = (fallback: boolean) =>
	z.preprocess(
		(value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
		z.preprocess(
			blankToUndefined,
			z
				.enum(["true", "false", "1", "0"])
				.transform((v) => v === "true" || v === "1")
				.default(fallback),
		),
	);

const envSchema = z.object({
	NODE_ENV: z.preprocess(
		blankToUndefined,
		z.enum(["development", "test", "production"]).default("development"),
	),
	PORT: int(3000, 1).pipe(z.number().max(65535)),
	LOG_LEVEL: z.preprocess(
		blankToUndefined,
		z.enum(["debug", "info", "warn", "error"]).default("info"),
	),
	DATABASE_URL: z.string().min(1),

	ENABLE_HTTP: flag(true),
	ENABLE_CONSUMER: flag(true),
	ENABLE_OUTBOX_PUBLISHER: flag(true),
	ENABLE_PENDING_WORKER: flag(true),

	DB_POOL_MAX: int(10, 1),
	LOCK_TIMEOUT_MS: int(5000, 1),
	STATEMENT_TIMEOUT_MS: int(15000, 1),

	PENDING_REF_MAX_ATTEMPTS: int(6, 1),
	PENDING_REF_BASE_MS: int(5000, 1),
	PENDING_REF_FACTOR: int(2, 1),
	PENDING_REF_CAP_MS: int(300000, 1),
	PENDING_REF_POLL_MS: int(1000, 1),
	PENDING_REF_CONCURRENCY: int(5, 1),

	OUTBOX_BATCH: int(10, 1),
	OUTBOX_POLL_MS: int(500, 1),
	OUTBOX_BACKOFF_BASE_MS: int(1000, 1),
	OUTBOX_BACKOFF_CAP_MS: int(60000, 1),

	SQS_MAX_RECEIVE: int(8, 1),
	SQS_HANDLER_TIMEOUT_MS: int(20000, 1),
	SQS_CONCURRENCY: int(5, 1),
	SQS_WAIT_TIME_S: int(20, 0).pipe(z.number().max(20)),
	SQS_BACKOFF_BASE_S: int(2, 1),
	SQS_BACKOFF_CAP_S: int(30, 1),
	SQS_ENDPOINT: text("http://localhost:4566"),
	SQS_REGION: text("us-east-1"),
	SQS_ACCESS_KEY_ID: text("test"),
	SQS_SECRET_ACCESS_KEY: text("test"),
	SQS_QUEUE_NAME: text("wager-transactions.fifo"),
	SQS_DLQ_NAME: text("wager-transactions-dlq.fifo"),
	SQS_EVENTS_QUEUE_NAME: text("wager-events.fifo"),
	SQS_QUEUE_URL: z.preprocess(blankToUndefined, z.string().optional()),
	SQS_EVENTS_QUEUE_URL: z.preprocess(blankToUndefined, z.string().optional()),

	BREAKER_COOLDOWN_MIN_MS: int(1000, 1),
	BREAKER_COOLDOWN_MAX_MS: int(30000, 1),

	SHUTDOWN_GRACE_MS: int(20000, 0),
	SHUTDOWN_DRAIN_DELAY_MS: int(0, 0),

	TEST_FAULT: z.preprocess(
		blankToUndefined,
		z.enum(FAULT_POINTS).or(z.literal("")).default(""),
	),
});

export interface AppConfig {
	nodeEnv: "development" | "test" | "production";
	port: number;
	logLevel: "debug" | "info" | "warn" | "error";
	databaseUrl: string;
	enableHttp: boolean;
	enableConsumer: boolean;
	enableOutboxPublisher: boolean;
	enablePendingWorker: boolean;
	dbPoolMax: number;
	lockTimeoutMs: number;
	statementTimeoutMs: number;
	pendingRef: {
		maxAttempts: number;
		baseMs: number;
		factor: number;
		capMs: number;
		pollMs: number;
		concurrency: number;
	};
	outbox: {
		batch: number;
		pollMs: number;
		backoffBaseMs: number;
		backoffCapMs: number;
	};
	sqs: {
		maxReceive: number;
		handlerTimeoutMs: number;
		concurrency: number;
		waitTimeSeconds: number;
		backoffBaseS: number;
		backoffCapS: number;
		endpoint: string;
		region: string;
		accessKeyId: string;
		secretAccessKey: string;
		queueName: string;
		dlqName: string;
		eventsQueueName: string;
		queueUrl: string | undefined;
		eventsQueueUrl: string | undefined;
	};
	breaker: { cooldownMinMs: number; cooldownMaxMs: number };
	shutdownGraceMs: number;
	/** Pause between "draining" and closing the listener, so readiness is seen failing (0 = none). */
	shutdownDrainDelayMs: number;
	testFault: FaultPoint | "";
}

function issuesOf(error: z.ZodError): ConfigIssue[] {
	return error.issues.map((issue) => {
		const variable = String(issue.path[0] ?? "(root)");
		const problem =
			issue.code === "invalid_type" && issue.input === undefined
				? "is required"
				: issue.message;
		return { variable, problem };
	});
}

/** Pure: validates and coerces `env`; never reads `process.env` itself. */
export function loadConfig(env: Env): AppConfig {
	const parsed = envSchema.safeParse(env);
	if (!parsed.success) throw new ConfigError(issuesOf(parsed.error));
	const e = parsed.data;

	const crossIssues: ConfigIssue[] = [];
	if (e.BREAKER_COOLDOWN_MIN_MS > e.BREAKER_COOLDOWN_MAX_MS) {
		crossIssues.push({
			variable: "BREAKER_COOLDOWN_MIN_MS",
			problem: "must not exceed BREAKER_COOLDOWN_MAX_MS",
		});
	}
	if (e.NODE_ENV === "production" && e.TEST_FAULT !== "") {
		crossIssues.push({
			variable: "TEST_FAULT",
			problem: "is refused when NODE_ENV=production",
		});
	}
	if (crossIssues.length > 0) throw new ConfigError(crossIssues);

	return {
		nodeEnv: e.NODE_ENV,
		port: e.PORT,
		logLevel: e.LOG_LEVEL,
		databaseUrl: e.DATABASE_URL,
		enableHttp: e.ENABLE_HTTP,
		enableConsumer: e.ENABLE_CONSUMER,
		enableOutboxPublisher: e.ENABLE_OUTBOX_PUBLISHER,
		enablePendingWorker: e.ENABLE_PENDING_WORKER,
		dbPoolMax: e.DB_POOL_MAX,
		lockTimeoutMs: e.LOCK_TIMEOUT_MS,
		statementTimeoutMs: e.STATEMENT_TIMEOUT_MS,
		pendingRef: {
			maxAttempts: e.PENDING_REF_MAX_ATTEMPTS,
			baseMs: e.PENDING_REF_BASE_MS,
			factor: e.PENDING_REF_FACTOR,
			capMs: e.PENDING_REF_CAP_MS,
			pollMs: e.PENDING_REF_POLL_MS,
			concurrency: e.PENDING_REF_CONCURRENCY,
		},
		outbox: {
			batch: e.OUTBOX_BATCH,
			pollMs: e.OUTBOX_POLL_MS,
			backoffBaseMs: e.OUTBOX_BACKOFF_BASE_MS,
			backoffCapMs: e.OUTBOX_BACKOFF_CAP_MS,
		},
		sqs: {
			maxReceive: e.SQS_MAX_RECEIVE,
			handlerTimeoutMs: e.SQS_HANDLER_TIMEOUT_MS,
			concurrency: e.SQS_CONCURRENCY,
			waitTimeSeconds: e.SQS_WAIT_TIME_S,
			backoffBaseS: e.SQS_BACKOFF_BASE_S,
			backoffCapS: e.SQS_BACKOFF_CAP_S,
			endpoint: e.SQS_ENDPOINT,
			region: e.SQS_REGION,
			accessKeyId: e.SQS_ACCESS_KEY_ID,
			secretAccessKey: e.SQS_SECRET_ACCESS_KEY,
			queueName: e.SQS_QUEUE_NAME,
			dlqName: e.SQS_DLQ_NAME,
			eventsQueueName: e.SQS_EVENTS_QUEUE_NAME,
			queueUrl: e.SQS_QUEUE_URL,
			eventsQueueUrl: e.SQS_EVENTS_QUEUE_URL,
		},
		breaker: {
			cooldownMinMs: e.BREAKER_COOLDOWN_MIN_MS,
			cooldownMaxMs: e.BREAKER_COOLDOWN_MAX_MS,
		},
		shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
		shutdownDrainDelayMs: e.SHUTDOWN_DRAIN_DELAY_MS,
		testFault: e.TEST_FAULT,
	};
}
