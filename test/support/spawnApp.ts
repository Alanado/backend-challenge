import { type AppProcess, freePort, spawnApp } from "./app-process";
import { eventually } from "./eventually";
import { sampleOf } from "./http-app";
import { testInfra } from "./infra";
import type { SuiteDatabase } from "./suite-database";
import type { SuiteQueues } from "./suite-queues";

export interface RoleFlags {
	consumer: boolean;
	outboxPublisher: boolean;
	pendingWorker: boolean;
}

export interface InstanceOptions {
	db: SuiteDatabase;
	/** Queues of the suite; without them the instance points at the default (non-suite) names. */
	queues?: SuiteQueues;
	/** Roles besides HTTP (always on: the helper needs the port); all on by default. */
	roles?: Partial<RoleFlags>;
	/** `TEST_FAULT` of this instance (03-messaging §9). */
	fault?: string;
	/** Extra environment; wins over everything the helper sets. */
	env?: Record<string, string>;
	/**
	 * What to wait for before returning: `live` (default), `ready`, or `none` for an instance that
	 * is expected to die by itself while booting (a `TEST_FAULT` with work already waiting).
	 */
	waitFor?: "live" | "ready" | "none";
}

export interface ExitInfo {
	exitCode: number | null;
	signalCode: string | null;
}

export interface Instance {
	readonly pid: number;
	readonly port: number;
	readonly base: string;
	readonly process: AppProcess;
	/** Sends `signal` and returns at once; pair it with `exited`. */
	kill(signal: NodeJS.Signals): void;
	/** Settles once the process is gone, with how it ended (a SIGKILL has `exitCode === null`). */
	readonly exited: Promise<ExitInfo>;
	hasExited(): boolean;
	stdout(): string;
	stderr(): string;
	/** Raw text of `GET /metrics`. */
	scrape(): Promise<string>;
	/** Value of one sample of `/metrics` (0 when the sample does not exist). */
	metric(name: string, labels?: Record<string, string>): Promise<number>;
	/** SIGKILL when still alive, then waits; safe to call twice. */
	stop(): Promise<void>;
}

/** Timings short enough for tests; every one can be overridden through `InstanceOptions.env`. */
const FAST_TIMINGS: Record<string, string> = {
	LOG_LEVEL: "warn",
	DB_POOL_MAX: "8",
	SQS_WAIT_TIME_S: "1",
	SQS_BACKOFF_BASE_S: "1",
	SQS_BACKOFF_CAP_S: "4",
	OUTBOX_POLL_MS: "100",
	OUTBOX_BACKOFF_BASE_MS: "200",
	OUTBOX_BACKOFF_CAP_MS: "1000",
	PENDING_REF_POLL_MS: "100",
	PENDING_REF_BASE_MS: "100",
	PENDING_REF_CAP_MS: "500",
	PENDING_REF_MAX_ATTEMPTS: "12",
	BREAKER_COOLDOWN_MIN_MS: "200",
	BREAKER_COOLDOWN_MAX_MS: "800",
};

/** Environment of an instance, exposed so a test can read what it will run with. */
export function instanceEnv(
	options: InstanceOptions,
	port: number,
): Record<string, string> {
	const roles: RoleFlags = {
		consumer: true,
		outboxPublisher: true,
		pendingWorker: true,
		...options.roles,
	};
	const { queues } = options;
	return {
		NODE_ENV: "test",
		...FAST_TIMINGS,
		DATABASE_URL: options.db.url,
		PORT: String(port),
		ENABLE_HTTP: "true",
		ENABLE_CONSUMER: String(roles.consumer),
		ENABLE_OUTBOX_PUBLISHER: String(roles.outboxPublisher),
		ENABLE_PENDING_WORKER: String(roles.pendingWorker),
		SQS_ENDPOINT: testInfra.sqsEndpoint,
		...(queues === undefined
			? {}
			: {
					SQS_QUEUE_NAME: queues.main.name,
					SQS_DLQ_NAME: queues.dlq.name,
					SQS_EVENTS_QUEUE_NAME: queues.events.name,
				}),
		...(options.fault === undefined ? {} : { TEST_FAULT: options.fault }),
		...options.env,
	};
}

function describeOutput(label: string, instance: Instance): string {
	return `--- ${label} (pid ${instance.pid}, port ${instance.port}) ---\nstdout:\n${instance.stdout()}\nstderr:\n${instance.stderr()}`;
}

/**
 * The instances of one test or suite. Whatever happens, `stopAll()` (call it in `afterAll`) leaves
 * no process behind, and `withOutputOnFailure` attaches the output of every instance to the error
 * of a failing test, so a red multi-process run explains itself.
 */
export class Fleet {
	private readonly started: Array<{ label: string; instance: Instance }> = [];

	async start(
		options: InstanceOptions,
		label = `instance-${this.started.length + 1}`,
	): Promise<Instance> {
		const port = await freePort();
		const base = `http://127.0.0.1:${port}`;
		const proc = spawnApp(instanceEnv(options, port));
		const instance = toInstance(proc, port, base);
		this.started.push({ label, instance });
		try {
			if (options.waitFor !== "none") {
				await waitUntilUp(instance, options.waitFor ?? "live");
			}
		} catch (error) {
			await instance.stop();
			throw new Error(
				`${label} did not come up: ${errorMessage(error)}\n${describeOutput(label, instance)}`,
				{ cause: error },
			);
		}
		return instance;
	}

	/** `count` identical instances, started together. */
	startMany(count: number, options: InstanceOptions): Promise<Instance[]> {
		return Promise.all(
			Array.from({ length: count }, (_, i) =>
				this.start(options, `instance-${this.started.length + i + 1}`),
			),
		);
	}

	outputs(): string {
		return this.started
			.map((s) => describeOutput(s.label, s.instance))
			.join("\n");
	}

	async withOutputOnFailure<T>(work: () => Promise<T>): Promise<T> {
		try {
			return await work();
		} catch (error) {
			throw new Error(`${errorMessage(error)}\n${this.outputs()}`, {
				cause: error,
			});
		}
	}

	async stopAll(): Promise<void> {
		await Promise.all(this.started.map((s) => s.instance.stop()));
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toInstance(proc: AppProcess, port: number, base: string): Instance {
	const exit = proc.exited.then(
		(): ExitInfo => ({
			exitCode: proc.proc.exitCode,
			signalCode:
				proc.proc.signalCode === null ? null : String(proc.proc.signalCode),
		}),
	);
	const instance: Instance = {
		pid: proc.proc.pid,
		port,
		base,
		process: proc,
		kill: (signal) => proc.proc.kill(signal),
		exited: exit,
		hasExited: () =>
			proc.proc.exitCode !== null || proc.proc.signalCode !== null,
		stdout: proc.stdout,
		stderr: proc.stderr,
		async scrape() {
			const response = await fetch(`${base}/metrics`);
			return response.text();
		},
		async metric(name, labels = {}) {
			return sampleOf(await instance.scrape(), name, labels);
		},
		async stop() {
			if (!instance.hasExited()) {
				proc.proc.kill("SIGKILL");
			}
			await exit;
		},
	};
	return instance;
}

async function waitUntilUp(
	instance: Instance,
	waitFor: "live" | "ready",
): Promise<void> {
	// A process that died will never answer: fail at once instead of polling until the timeout.
	const died = instance.exited.then((exit) => {
		throw new Error(
			`the process exited before it came up (exitCode=${exit.exitCode}, signal=${exit.signalCode})`,
		);
	});
	const answers = eventually(
		async () => {
			const live = await fetch(`${instance.base}/health/live`);
			if (live.status !== 200) throw new Error(`live answered ${live.status}`);
			if (waitFor === "ready") {
				const ready = await fetch(`${instance.base}/health/ready`);
				if (ready.status !== 200) {
					throw new Error(`ready answered ${ready.status}`);
				}
			}
		},
		{ timeout: 30_000, interval: 100 },
	);
	await Promise.race([answers, died]);
}
