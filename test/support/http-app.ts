import { payloadHash } from "../../src/modules/wagering/domain/payload-hash";
import { Money } from "../../src/shared/money";
import { type AppProcess, freePort, spawnApp } from "./app-process";
import { uniqueId } from "./ids";
import type { SuiteDatabase } from "./suite-database";

export interface Reply {
	status: number;
	headers: Headers;
	// biome-ignore lint/suspicious/noExplicitAny: test client; assertions narrow each field they read
	body: any;
}

export interface TestWallet {
	id: string;
	playerId: string;
	currency: string;
}

export interface SubmitBody {
	providerId: string;
	externalTransactionId: string;
	playerId: string;
	walletId: string;
	roundId: string;
	gameId: string;
	kind: string;
	money: { amount: string; currency: string };
	referenceExternalTransactionId?: string;
}

export interface SubmitOptions {
	kind?: string;
	externalTransactionId?: string;
	providerId?: string;
	reference?: string;
	/** Defaults to `{providerId}:{externalTransactionId}`. */
	key?: string;
	headers?: Record<string, string>;
	currency?: string;
}

export interface HttpApp {
	base: string;
	process: AppProcess;
	request(
		method: string,
		path: string,
		options?: { body?: unknown; headers?: Record<string, string> },
	): Promise<Reply>;
	createWallet(balance: string, currency?: string): Promise<TestWallet>;
	/** Builds the body and the headers of a submission; the caller may tamper with them. */
	buildSubmit(
		wallet: TestWallet,
		amount: string,
		options?: SubmitOptions,
	): { body: SubmitBody; headers: Record<string, string> };
	submit(
		wallet: TestWallet,
		amount: string,
		options?: SubmitOptions,
	): Promise<Reply>;
	/** Current value of a counter sample (0 when the sample does not exist yet). */
	metric(name: string, labels?: Record<string, string>): Promise<number>;
	balanceOf(wallet: TestWallet): Promise<string>;
	stop(): Promise<void>;
}

export interface StartOptions {
	/** Extra environment (LOCK_TIMEOUT_MS, DB_POOL_MAX, ...). */
	env?: Record<string, string>;
}

/** The real application as a child process on an ephemeral port: only HTTP, real Postgres. */
export async function startHttpApp(
	db: SuiteDatabase,
	options: StartOptions = {},
): Promise<HttpApp> {
	const port = await freePort();
	const base = `http://127.0.0.1:${port}`;
	const process = spawnApp({
		DATABASE_URL: db.url,
		PORT: String(port),
		ENABLE_CONSUMER: "false",
		ENABLE_OUTBOX_PUBLISHER: "false",
		ENABLE_PENDING_WORKER: "false",
		LOG_LEVEL: "info",
		...options.env,
	});
	await process.waitForStdout("app_started");

	const request: HttpApp["request"] = async (method, path, opts = {}) => {
		const hasBody = opts.body !== undefined;
		const response = await fetch(`${base}${path}`, {
			method,
			headers: {
				...(hasBody ? { "Content-Type": "application/json" } : {}),
				...opts.headers,
			},
			...(hasBody
				? {
						body:
							typeof opts.body === "string"
								? opts.body
								: JSON.stringify(opts.body),
					}
				: {}),
		});
		const text = await response.text();
		let body: unknown = text;
		try {
			body = text === "" ? null : JSON.parse(text);
		} catch {
			// not JSON (the Prometheus text format): keep the raw text
		}
		return { status: response.status, headers: response.headers, body };
	};

	const app: HttpApp = {
		base,
		process,
		request,
		async createWallet(balance, currency = "BRL") {
			const playerId = uniqueId();
			const reply = await request("POST", "/wallets", {
				body: { playerId, initialBalance: { amount: balance, currency } },
			});
			if (reply.status !== 201) {
				throw new Error(`createWallet failed: ${reply.status} ${reply.body}`);
			}
			return { id: reply.body.id as string, playerId, currency };
		},
		buildSubmit(wallet, amount, o = {}) {
			const providerId = o.providerId ?? "provider-a";
			const externalTransactionId =
				o.externalTransactionId ?? `ext-${uniqueId()}`;
			const body: SubmitBody = {
				providerId,
				externalTransactionId,
				playerId: wallet.playerId,
				walletId: wallet.id,
				roundId: "round-1",
				gameId: "game-1",
				kind: o.kind ?? "BET",
				money: { amount, currency: o.currency ?? wallet.currency },
				...(o.reference === undefined
					? {}
					: { referenceExternalTransactionId: o.reference }),
			};
			return {
				body,
				headers: {
					"Idempotency-Key": o.key ?? `${providerId}:${externalTransactionId}`,
					...o.headers,
				},
			};
		},
		submit(wallet, amount, o) {
			const { body, headers } = app.buildSubmit(wallet, amount, o);
			return request("POST", "/wagering/transactions", { body, headers });
		},
		async metric(name, labels = {}) {
			const reply = await request("GET", "/metrics");
			return sampleOf(String(reply.body), name, labels);
		},
		async balanceOf(wallet) {
			const reply = await request("GET", `/wallets/${wallet.id}`);
			return reply.body.balance.amount as string;
		},
		stop: () => process.stop(),
	};
	return app;
}

/** Sums the samples of `name` whose labels include `labels` (Prometheus text format). */
export function sampleOf(
	text: string,
	name: string,
	labels: Record<string, string>,
): number {
	let total = 0;
	for (const line of text.split("\n")) {
		if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
		const match = /^[a-z_:0-9]+(?:\{(.*)\})?\s+(\S+)$/i.exec(line);
		if (match === null) continue;
		const present = new Map<string, string>();
		for (const pair of (match[1] ?? "").matchAll(
			/(\w+)="((?:[^"\\]|\\.)*)"/g,
		)) {
			present.set(pair[1] ?? "", pair[2] ?? "");
		}
		if (Object.entries(labels).every(([k, v]) => present.get(k) === v)) {
			total += Number(match[2]);
		}
	}
	return total;
}

/** The `payloadHash` the API computes for `body`; for rows a test writes straight into the table. */
export function hashOf(body: SubmitBody): string {
	return payloadHash({
		providerId: body.providerId,
		externalTransactionId: body.externalTransactionId,
		playerId: body.playerId,
		walletId: body.walletId,
		roundId: body.roundId,
		gameId: body.gameId,
		kind: body.kind as never,
		money: Money.from(body.money),
		referenceExternalTransactionId: body.referenceExternalTransactionId,
	});
}
