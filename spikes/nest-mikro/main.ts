// Spike R-02 (T-002): NestJS + MikroORM no Bun. Pré-requisito: Postgres de teste no ar
// (`bun run test:infra:up`). Variável opcional: SPIKE_DATABASE_URL.
import "reflect-metadata";
import { EntitySchema, LockMode } from "@mikro-orm/core";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { EntityManager, PostgreSqlDriver } from "@mikro-orm/postgresql";
import { Controller, Get, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Client } from "pg";
import { assert, check, finish, note } from "../lib/check";

const DATABASE_URL =
	process.env.SPIKE_DATABASE_URL ??
	"postgres://wagering:wagering@localhost:5433/spike";
const sqlLog: string[] = [];

// O banco `spike` não vem no compose: cria se faltar (conectando ao banco administrativo `postgres`).
{
	const adminUrl = new URL(DATABASE_URL);
	const dbName = adminUrl.pathname.slice(1);
	adminUrl.pathname = "/postgres";
	const admin = new Client({ connectionString: adminUrl.toString() });
	await admin.connect();
	const exists = await admin.query(
		"select 1 from pg_database where datname = $1",
		[dbName],
	);
	if (exists.rowCount === 0) await admin.query(`create database "${dbName}"`);
	await admin.end();
}

class Account {
	id!: number;
	balance!: string;
}

const AccountSchema = new EntitySchema<Account>({
	class: Account,
	tableName: "spike_account",
	properties: {
		id: { type: "number", primary: true, autoincrement: false },
		balance: { type: "string", columnType: "numeric(19,2)" },
	},
});

@Injectable()
class AccountService {
	// Sem @Inject: depende só de emitDecoratorMetadata.
	constructor(private readonly em: EntityManager) {}

	entityManager(): EntityManager {
		return this.em;
	}
}

@Controller()
class PingController {
	constructor(private readonly accounts: AccountService) {}

	@Get("ping")
	ping(): { ok: boolean; hasEm: boolean } {
		return {
			ok: true,
			hasEm: this.accounts.entityManager() instanceof EntityManager,
		};
	}
}

@Module({
	imports: [
		MikroOrmModule.forRoot({
			driver: PostgreSqlDriver,
			clientUrl: DATABASE_URL,
			entities: [AccountSchema],
			debug: ["query"],
			colors: false,
			logger: (message: string) => sqlLog.push(message),
			pool: { min: 0, max: 10 },
		}),
		MikroOrmModule.forFeature([AccountSchema]),
	],
	providers: [AccountService],
	controllers: [PingController],
})
class AppModule {}

function locateCode(err: unknown): string {
	const paths: string[] = [];
	const seen = new Set<unknown>();
	const walk = (value: unknown, path: string): void => {
		if (typeof value !== "object" || value === null || seen.has(value)) return;
		seen.add(value);
		const code = (value as { code?: unknown }).code;
		if (typeof code === "string") paths.push(`${path}.code=${code}`);
		for (const key of ["cause", "original", "previous"]) {
			walk((value as Record<string, unknown>)[key], `${path}.${key}`);
		}
	};
	walk(err, "err");
	const ctor = err instanceof Error ? err.constructor.name : typeof err;
	return `${ctor}; ${paths.join(" | ") || "no code found"}`;
}

function codeOf(err: unknown): string | undefined {
	return (
		(err as { code?: string })?.code ??
		(err as { cause?: { code?: string } })?.cause?.code
	);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const app = await NestFactory.create(AppModule, { logger: ["error"] });
await app.listen(0);
const port = new URL(
	await app.getUrl().then((u) => u.replace("[::1]", "localhost")),
).port;
const em = app.get(EntityManager);

const raw = new Client({ connectionString: DATABASE_URL });
await raw.connect();
await raw.query("drop table if exists spike_account");
await raw.query(
	"create table spike_account (id int primary key, balance numeric(19,2) not null)",
);
await raw.query("insert into spike_account values (1, '10.00'), (2, '20.00')");
await raw.query("drop table if exists spike_migrated");
await raw.query("drop table if exists mikro_orm_migrations");

await check(
	"1",
	"Nest sobe no Bun com @mikro-orm/nestjs (adaptador HTTP)",
	async () => {
		const adapter = app.getHttpAdapter().getType();
		assert(
			adapter === "express",
			`adaptador esperado express, obtido ${adapter}`,
		);
		const res = await fetch(`http://localhost:${port}/ping`);
		assert(res.status === 200, `GET /ping status ${res.status}`);
		return `adapter=${adapter}; GET /ping -> ${JSON.stringify(await res.json())}`;
	},
);

await check(
	"2",
	"DI por tipo de construtor (emitDecoratorMetadata, sem @Inject)",
	async () => {
		const body = (await (
			await fetch(`http://localhost:${port}/ping`)
		).json()) as { hasEm: boolean };
		assert(
			body.hasEm === true,
			"AccountService recebeu EntityManager sem @Inject",
		);
		return "PingController <- AccountService <- EntityManager";
	},
);

await check(
	"3",
	"em.transactional: commit e rollback visíveis de outra conexão",
	async () => {
		await em.fork().transactional(async (tx) => {
			await tx.execute(
				"update spike_account set balance = '11.00' where id = 1",
			);
			const inside = await raw.query(
				"select balance from spike_account where id = 1",
			);
			assert(
				inside.rows[0].balance === "10.00",
				"outra conexão não deve ver dado não commitado",
			);
		});
		const afterCommit = await raw.query(
			"select balance from spike_account where id = 1",
		);
		assert(afterCommit.rows[0].balance === "11.00", "commit efetivo");

		await em
			.fork()
			.transactional(async (tx) => {
				await tx.execute(
					"update spike_account set balance = '99.00' where id = 1",
				);
				throw new Error("boom");
			})
			.catch(() => undefined);
		const afterRollback = await raw.query(
			"select balance from spike_account where id = 1",
		);
		assert(afterRollback.rows[0].balance === "11.00", "rollback efetivo");
		return "commit visível só após o fim; rollback desfeito";
	},
);

await check("4a", "LockMode.PESSIMISTIC_WRITE gera FOR UPDATE", async () => {
	sqlLog.length = 0;
	await em.fork().transactional(async (tx) => {
		await tx.findOne(Account, 1, { lockMode: LockMode.PESSIMISTIC_WRITE });
	});
	const sql = sqlLog.find(
		(s) => /for update/i.test(s) && !/skip locked|nowait/i.test(s),
	);
	assert(sql, `nenhum SQL com FOR UPDATE: ${sqlLog.join(" || ")}`);
	return sql.replace(/\s+/g, " ").slice(0, 160);
});

await check(
	"4b",
	"LockMode.PESSIMISTIC_PARTIAL_WRITE gera FOR UPDATE SKIP LOCKED",
	async () => {
		sqlLog.length = 0;
		await em.fork().transactional(async (tx) => {
			await tx.find(
				Account,
				{ id: 1 },
				{ lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
			);
		});
		const sql = sqlLog.find((s) => /for update skip locked/i.test(s));
		assert(sql, `nenhum SQL com SKIP LOCKED: ${sqlLog.join(" || ")}`);
		return sql.replace(/\s+/g, " ").slice(0, 160);
	},
);

// Mantém a linha 1 travada numa transação real enquanto as outras conexões tentam.
async function withHeldLock(body: () => Promise<void>): Promise<void> {
	const locked = deferred();
	const release = deferred();
	const holder = em.fork().transactional(async (tx) => {
		await tx.findOne(Account, 1, { lockMode: LockMode.PESSIMISTIC_WRITE });
		locked.resolve();
		await release.promise;
	});
	await locked.promise;
	try {
		await body();
	} finally {
		release.resolve();
		await holder;
	}
}

await check(
	"4c",
	"duas conexões reais: FOR UPDATE espera; SKIP LOCKED pula; NOWAIT falha",
	async () => {
		const report: string[] = [];
		await withHeldLock(async () => {
			// FOR UPDATE: espera até o lock_timeout.
			const started = Date.now();
			let waitedErr: unknown;
			await em
				.fork()
				.transactional(async (tx) => {
					await tx.execute("set local lock_timeout = '400ms'");
					await tx.findOne(Account, 1, {
						lockMode: LockMode.PESSIMISTIC_WRITE,
					});
				})
				.catch((e) => {
					waitedErr = e;
				});
			const waited = Date.now() - started;
			assert(
				waitedErr && codeOf(waitedErr) === "55P03",
				`esperava 55P03, obtido ${locateCode(waitedErr)}`,
			);
			assert(
				waited >= 350,
				`FOR UPDATE deveria esperar o lock_timeout (esperou ${waited}ms)`,
			);
			report.push(`FOR UPDATE esperou ${waited}ms e falhou com 55P03`);

			// SKIP LOCKED: não espera e não devolve a linha travada.
			const skipStart = Date.now();
			const rows = await em.fork().transactional(async (tx) =>
				tx.find(
					Account,
					{},
					{
						lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
						orderBy: { id: "asc" },
					},
				),
			);
			const skipMs = Date.now() - skipStart;
			assert(
				rows.length === 1 && rows[0]?.id === 2,
				`SKIP LOCKED deveria devolver só a linha 2: ${rows.map((r) => r.id)}`,
			);
			assert(skipMs < 300, `SKIP LOCKED não deveria esperar (${skipMs}ms)`);
			report.push(`SKIP LOCKED pulou a linha 1 em ${skipMs}ms`);

			// NOWAIT: falha na hora.
			const nowaitErr = await em
				.fork()
				.transactional(async (tx) => {
					await tx.findOne(Account, 1, {
						lockMode: LockMode.PESSIMISTIC_WRITE_OR_FAIL,
					});
				})
				.then(() => undefined)
				.catch((e) => e);
			assert(
				codeOf(nowaitErr) === "55P03",
				`NOWAIT esperava 55P03: ${locateCode(nowaitErr)}`,
			);
			report.push("NOWAIT falhou na hora com 55P03");
		});
		return report.join("; ");
	},
);

await check(
	"5a",
	"SET LOCAL lock_timeout -> 55P03; local onde está o code",
	async () => {
		let caught: unknown;
		await withHeldLock(async () => {
			await em
				.fork()
				.transactional(async (tx) => {
					await tx.execute("set local lock_timeout = '200ms'");
					await tx.execute(
						"select * from spike_account where id = 1 for update",
					);
				})
				.catch((e) => {
					caught = e;
				});
		});
		assert(codeOf(caught) === "55P03", `esperava 55P03: ${locateCode(caught)}`);
		const after = await raw.query("show lock_timeout");
		assert(
			after.rows[0].lock_timeout !== "200ms",
			"SET LOCAL vazou para fora da transação",
		);
		return locateCode(caught);
	},
);

await check("5b", "deadlock (dois FOR UPDATE cruzados) -> 40P01", async () => {
	const lockedByA = deferred();
	const lockedByB = deferred();
	const crossed = (
		own: number,
		other: number,
		mine: ReturnType<typeof deferred>,
		theirs: ReturnType<typeof deferred>,
	) =>
		em
			.fork()
			.transactional(async (tx) => {
				await tx.findOne(Account, own, {
					lockMode: LockMode.PESSIMISTIC_WRITE,
				});
				mine.resolve();
				await theirs.promise;
				await tx.findOne(Account, other, {
					lockMode: LockMode.PESSIMISTIC_WRITE,
				});
			})
			.then(() => undefined)
			.catch((e) => e);
	const [a, b] = await Promise.all([
		crossed(1, 2, lockedByA, lockedByB),
		crossed(2, 1, lockedByB, lockedByA),
	]);
	const codes = [a, b].map(codeOf);
	assert(
		codes.filter((c) => c === "40P01").length === 1,
		`esperava exatamente um 40P01, obtido ${codes}`,
	);
	return locateCode([a, b].find((e) => codeOf(e) === "40P01"));
});

await check("5c", "SET LOCAL statement_timeout -> 57014", async () => {
	const err = await em
		.fork()
		.transactional(async (tx) => {
			await tx.execute("set local statement_timeout = '200ms'");
			await tx.execute("select pg_sleep(2)");
		})
		.then(() => undefined)
		.catch((e) => e);
	assert(codeOf(err) === "57014", `esperava 57014: ${locateCode(err)}`);
	return locateCode(err);
});

await check(
	"6",
	"numeric(19,2) vai e volta como string, sem passar por number",
	async () => {
		const big = "12345678901234567.89";
		await em.fork().transactional(async (tx) => {
			tx.create(Account, { id: 3, balance: big });
			await tx.flush();
		});
		const viaRaw = await raw.query(
			"select balance from spike_account where id = 3",
		);
		assert(
			viaRaw.rows[0].balance === big,
			`driver devolveu ${viaRaw.rows[0].balance}`,
		);
		const loaded = await em.fork().findOneOrFail(Account, 3);
		assert(
			typeof loaded.balance === "string" && loaded.balance === big,
			`entidade devolveu ${typeof loaded.balance} ${loaded.balance}`,
		);
		const viaOrmRaw = await em
			.fork()
			.execute("select balance + 0.01 as b from spike_account where id = 3");
		assert(
			viaOrmRaw[0]?.b === "12345678901234567.90",
			`em.execute devolveu ${JSON.stringify(viaOrmRaw[0])}`,
		);
		return `${big} (entity: ${typeof loaded.balance}; em.execute: ${typeof viaOrmRaw[0]?.b})`;
	},
);

const migrationEnv = {
	...process.env,
	DATABASE_URL,
	MIGRATIONS_PATH: "spikes/nest-mikro/migrations",
};
async function runScript(
	script: string,
	extraEnv: Record<string, string> = {},
): Promise<string> {
	const proc = Bun.spawn(["bun", "run", script], {
		env: { ...migrationEnv, ...extraEnv },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	assert(code === 0, `${script} saiu com ${code}: ${err || out}`);
	return out.trim().split("\n").pop() ?? "";
}
async function tableExists(name: string): Promise<boolean> {
	return (
		(await raw.query("select to_regclass($1) as t", [name])).rows[0].t !== null
	);
}

await check("7a", "EntitySchema (sem decorators) mapeia a tabela", async () => {
	const rows = await em.fork().find(Account, {}, { orderBy: { id: "asc" } });
	assert(
		rows.length >= 2,
		"EntitySchema deveria ler as linhas de spike_account",
	);
	return `${rows.length} linhas lidas via EntitySchema`;
});

await check(
	"7b",
	"scripts migration:up / migration:down (migration trivial)",
	async () => {
		const up = await runScript("migration:up");
		assert(
			await tableExists("spike_migrated"),
			`migration:up não criou a tabela (${up})`,
		);
		const down = await runScript("migration:down");
		assert(
			!(await tableExists("spike_migrated")),
			`migration:down não removeu a tabela (${down})`,
		);
		return `${up} | ${down}`;
	},
);

await check(
	"7c",
	"script migration:create gera o arquivo de migration",
	async () => {
		const dir = `${process.env.TMPDIR ?? "/tmp"}/spike-migrations-${Date.now()}`;
		const out = await runScript("migration:create", { MIGRATIONS_PATH: dir });
		const files = [...new Bun.Glob("*.ts").scanSync(dir)];
		assert(files.length === 1, `esperava 1 arquivo em ${dir}, obtido ${files}`);
		return `${out} (${files[0]})`;
	},
);

await check("8", "versões exatas registradas", async () => {
	const version = async (pkg: string): Promise<string> =>
		(await Bun.file(`node_modules/${pkg}/package.json`).json()).version;
	const pg = await raw.query("select version() as v");
	const versions = {
		bun: Bun.version,
		"@nestjs/core": await version("@nestjs/core"),
		"@mikro-orm/core": await version("@mikro-orm/core"),
		"@mikro-orm/nestjs": await version("@mikro-orm/nestjs"),
		"@mikro-orm/postgresql": await version("@mikro-orm/postgresql"),
		"@mikro-orm/migrations": await version("@mikro-orm/migrations"),
		pg: await version("pg"),
		postgres: String(pg.rows[0].v).split(" on ")[0],
	};
	note(JSON.stringify(versions));
	return JSON.stringify(versions);
});

await raw.end();
await app.close();
finish("spike:nest-mikro");
