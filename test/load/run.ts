/**
 * `bun run test:load` (stretch S-01, ADR-0021). Fresh database and queues, three real instances,
 * four scenarios, then the ledger invariant over every wallet touched. Exit 1 on any violation or
 * unexpected error. Needs `bun run test:infra:up`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newSqsClient } from "../support/event-consumer";
import { testInfra } from "../support/infra";
import { createPersistence } from "../support/persistence";
import { Fleet } from "../support/spawnApp";
import { connect } from "../support/sql";
import { createSuiteDatabase } from "../support/suite-database";
import { createSuiteQueues } from "../support/suite-queues";
import { environment, rssMb } from "./lib/observe";
import { runStrategy, type StrategyResult } from "./lib/strategies";
import { verifyConsistency, waitOutboxDrained } from "./lib/verify";
import { PROFILES, type Profile } from "./profiles";
import { renderStrategyTable, renderTable } from "./report";
import {
	type Context,
	runScenario,
	SCENARIOS,
	type ScenarioResult,
} from "./scenarios";

interface Options {
	profile: string;
	out: string;
	instances: number;
	seed: number;
	scenarios: string[];
	ab: boolean;
	overrides: Partial<Pick<Profile, "warmupMs" | "measureMs">> & {
		concurrency?: number;
		hotConcurrency?: number;
	};
}

function parseArgs(argv: readonly string[]): Options {
	const options: Options = {
		profile: "full",
		out: join(import.meta.dir, "results"),
		instances: 3,
		seed: 20261029,
		scenarios: SCENARIOS.map((s) => s.id),
		ab: true,
		overrides: {},
	};
	const args = argv.filter((a) => a !== "--");
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		if (flag === "--skip-ab") {
			options.ab = false;
			continue;
		}
		const value = args[++i];
		if (value === undefined) throw new Error(`${flag} needs a value`);
		const seconds = (v: string) => Number(v) * 1000;
		switch (flag) {
			case "--profile":
				options.profile = value;
				break;
			case "--out":
				options.out = value;
				break;
			case "--instances":
				options.instances = Number(value);
				break;
			case "--seed":
				options.seed = Number(value);
				break;
			case "--scenarios":
				options.scenarios = value.split(",").map((s) => s.trim().toUpperCase());
				break;
			case "--warmup-s":
				options.overrides.warmupMs = seconds(value);
				break;
			case "--duration-s":
				options.overrides.measureMs = seconds(value);
				break;
			case "--concurrency":
				options.overrides.concurrency = Number(value);
				break;
			case "--hot-concurrency":
				options.overrides.hotConcurrency = Number(value);
				break;
			default:
				throw new Error(`unknown flag ${flag}`);
		}
	}
	return options;
}

function resolveProfile(options: Options): Profile {
	const base = PROFILES[options.profile];
	if (base === undefined) {
		throw new Error(
			`unknown profile ${options.profile} (${Object.keys(PROFILES).join(", ")})`,
		);
	}
	const o = options.overrides;
	return {
		...base,
		...(o.warmupMs === undefined ? {} : { warmupMs: o.warmupMs }),
		...(o.measureMs === undefined ? {} : { measureMs: o.measureMs }),
		n1: { ...base.n1, concurrency: o.concurrency ?? base.n1.concurrency },
		n2: { concurrency: o.hotConcurrency ?? base.n2.concurrency },
		n3: { ...base.n3, concurrency: o.concurrency ?? base.n3.concurrency },
	};
}

async function postgresVersion(
	sql: Awaited<ReturnType<typeof connect>>,
): Promise<string> {
	const result = await sql.query("show server_version");
	return String(result.rows[0].server_version);
}

async function localstackVersion(): Promise<string> {
	try {
		const response = await fetch(`${testInfra.sqsEndpoint}/_localstack/health`);
		const body = (await response.json()) as { version?: string };
		return body.version ?? "unknown";
	} catch {
		return "unknown";
	}
}

async function main(): Promise<number> {
	const options = parseArgs(Bun.argv.slice(2));
	const profile = resolveProfile(options);
	const wanted = SCENARIOS.filter((s) => options.scenarios.includes(s.id));
	if (wanted.length === 0) throw new Error("no scenario selected");

	const db = await createSuiteDatabase();
	const queues = await createSuiteQueues("load");
	const p = await createPersistence(db.url);
	const sql = await connect(db.url);
	const sqs = newSqsClient();
	const fleet = new Fleet();
	try {
		// Compose parity: pool of 10 per instance and every role on (the Compose runs the defaults).
		const instances = await fleet.startMany(options.instances, {
			db,
			queues,
			waitFor: "ready",
			env: { DB_POOL_MAX: "10" },
		});
		const ctx: Context = {
			instances,
			sql,
			p,
			sqs,
			queues,
			profile,
			seed: options.seed,
		};

		const results: ScenarioResult[] = [];
		for (const scenario of wanted) {
			console.log(`running ${scenario.id} ${scenario.name} ...`);
			results.push(await runScenario(scenario, ctx));
		}

		// A x C: SQL only, isolated from the application (ADR-0021).
		const strategies: StrategyResult[] = [];
		if (options.ab) {
			for (let round = 0; round < profile.ab.rounds; round++) {
				for (const strategy of ["A", "C"] as const) {
					console.log(`running A x C round ${round + 1}: ${strategy} ...`);
					strategies.push(
						await runStrategy(
							strategy,
							{
								url: db.url,
								clients: profile.ab.clients,
								attemptsPerClient: profile.ab.attemptsPerClient,
								amount: "1.00",
								fundedPercent: 60,
							},
							p,
						),
					);
				}
			}
		}

		// Whole-run verification over every wallet that exists.
		await waitOutboxDrained(sql);
		const all = await sql.query("select id from wallets");
		const violations = await verifyConsistency({
			p,
			sql,
			walletIds: all.rows.map((r) => r.id as string),
		});

		const memory = {
			instancesRssMb: instances.map((i) => Math.round(rssMb(i.pid) ?? -1)),
			generatorRssMb: Math.round(rssMb(process.pid) ?? -1),
		};
		const report = {
			generatedAt: new Date().toISOString(),
			profile: profile.name,
			profileSettings: profile,
			seed: options.seed,
			instances: instances.length,
			poolMaxPerInstance: 10,
			environment: {
				...environment(),
				postgres: await postgresVersion(sql),
				localstack: await localstackVersion(),
			},
			memory,
			results,
			strategies,
			verification: { walletsChecked: all.rowCount ?? 0, violations },
		};

		console.log(`\n${renderTable(results)}\n`);
		if (strategies.length > 0) {
			console.log(`${renderStrategyTable(strategies)}\n`);
		}
		console.log(
			`memory (RSS MB): instances ${memory.instancesRssMb.join("/")}, generator ${memory.generatorRssMb}`,
		);
		for (const r of results) {
			if (r.generatorCpuPercent > 90) {
				console.log(
					`warning: the load generator was near saturation in ${r.id} (${r.generatorCpuPercent.toFixed(0)} % of a core)`,
				);
			}
		}

		mkdirSync(options.out, { recursive: true });
		const file = join(
			options.out,
			`load-${profile.name}-${report.generatedAt.replaceAll(":", "-")}.json`,
		);
		writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
		console.log(`json: ${file}`);

		const failures = [
			...results.flatMap((r) => r.violations.map((v) => `${r.id}: ${v}`)),
			...strategies.flatMap((s) =>
				s.violations.map((v) => `A x C ${s.strategy}: ${v}`),
			),
			...strategies
				.filter((s) => s.versionConflicts > 0 || s.otherErrors > 0)
				.map(
					(s) =>
						`A x C ${s.strategy}: ${s.versionConflicts} version conflicts, ${s.otherErrors} errors`,
				),
			...violations.map((v) => `final: ${v}`),
		];
		if (failures.length > 0) {
			console.error(`ledger invariant: VIOLATED\n${failures.join("\n")}`);
			return 1;
		}
		console.log(`ledger invariant: OK (${all.rowCount} wallets checked)`);
		return 0;
	} finally {
		await fleet.stopAll();
		sqs.destroy();
		await sql.end();
		await p.close();
		await queues.destroy();
		await db.drop();
	}
}

main().then(
	(code) => process.exit(code),
	(error) => {
		console.error(error);
		process.exit(1);
	},
);
