import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import {
	DEFAULT_MIGRATIONS_PATH,
	withMigrator,
} from "../../scripts/lib/migrator";
import { eventually } from "./eventually";
import { testInfra } from "./infra";

// Advisory-lock keys (arbitrary constants): one guards template creation, one guards CREATE DATABASE.
const TEMPLATE_BUILD_LOCK = 7_301_001;
const SUITE_CREATE_LOCK = 7_301_002;

export interface SuiteDatabase {
	name: string;
	url: string;
	templateName: string;
	templateUrl: string;
	/** DROP DATABASE ... WITH (FORCE); safe to call twice. */
	drop(): Promise<void>;
}

export interface CreateSuiteDatabaseOptions {
	/** Default true: clone the migrated template. False: an empty database (for up/down tests). */
	migrated?: boolean;
}

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

function urlFor(database: string): string {
	const url = new URL(testInfra.databaseUrl);
	url.pathname = `/${database}`;
	return url.toString();
}

export function migrationsPath(): string {
	return process.env.MIGRATIONS_PATH ?? DEFAULT_MIGRATIONS_PATH;
}

function migrationFiles(path: string): string[] {
	if (!existsSync(path)) return [];
	return readdirSync(path)
		.filter((file) => /\.(ts|js)$/.test(file) && !file.endsWith(".d.ts"))
		.sort();
}

/** The template name embeds a hash of the migration sources, so it tracks them as they appear. */
function templateNameFor(path: string): string {
	const hasher = new Bun.CryptoHasher("sha1");
	for (const file of migrationFiles(path)) {
		hasher.update(file);
		hasher.update(readFileSync(join(path, file)));
	}
	return `wagering_tmpl_${hasher.digest("hex").slice(0, 12)}`;
}

async function withAdmin<T>(work: (admin: Client) => Promise<T>): Promise<T> {
	const admin = new Client({ connectionString: testInfra.databaseUrl });
	await admin.connect();
	try {
		return await work(admin);
	} finally {
		await admin.end();
	}
}

async function connectionsOn(admin: Client, database: string): Promise<number> {
	const res = await admin.query(
		"select count(*)::int as n from pg_stat_activity where datname = $1",
		[database],
	);
	return res.rows[0].n as number;
}

async function databaseExists(admin: Client, name: string): Promise<boolean> {
	const res = await admin.query(
		"select 1 from pg_database where datname = $1",
		[name],
	);
	return res.rowCount === 1;
}

async function buildTemplate(name: string, path: string): Promise<void> {
	await withAdmin(async (admin) => {
		await admin.query("select pg_advisory_lock($1)", [TEMPLATE_BUILD_LOCK]);
		if (await databaseExists(admin, name)) return;

		// Build under a scratch name and rename at the end, so a crash never leaves a half-migrated template.
		const building = `${name}_building_${Bun.randomUUIDv7().replaceAll("-", "").slice(0, 8)}`;
		await admin.query(`create database ${quote(building)}`);
		try {
			if (migrationFiles(path).length > 0) {
				await withMigrator(
					urlFor(building),
					path,
					(migrator) => migrator.up(),
					{
						silent: true,
					},
				);
			}
			// The pool's backends exit asynchronously after close; RENAME needs them gone.
			await eventually(
				async () => (await connectionsOn(admin, building)) === 0,
				{
					timeout: 10_000,
					interval: 20,
				},
			);
			await admin.query(
				`alter database ${quote(building)} rename to ${quote(name)}`,
			);
		} catch (err) {
			await admin.query(
				`drop database if exists ${quote(building)} with (force)`,
			);
			throw err;
		}
	});
}

// One template build per process; across processes the advisory lock + existence check do the same.
let templateReady: Promise<string> | undefined;

function ensureTemplate(): Promise<string> {
	if (templateReady === undefined) {
		const path = migrationsPath();
		const name = templateNameFor(path);
		templateReady = buildTemplate(name, path).then(
			() => name,
			(err) => {
				templateReady = undefined;
				throw err;
			},
		);
	}
	return templateReady;
}

/** Creates an isolated database for one suite: a clone of the migrated template (ADR-0019). */
export async function createSuiteDatabase(
	options: CreateSuiteDatabaseOptions = {},
): Promise<SuiteDatabase> {
	const { migrated = true } = options;
	const templateName = await ensureTemplate();
	const name = `suite_${Bun.randomUUIDv7().replaceAll("-", "").slice(-16)}`;

	await withAdmin(async (admin) => {
		// Serialises the check + clone so concurrent callers of this helper cannot trip over each other.
		await admin.query("select pg_advisory_lock($1)", [SUITE_CREATE_LOCK]);
		if (migrated) {
			const open = await connectionsOn(admin, templateName);
			if (open > 0) {
				throw new Error(
					`${open} open connection(s) on template ${templateName}; nothing may connect to the template`,
				);
			}
			await admin.query(
				`create database ${quote(name)} template ${quote(templateName)}`,
			);
		} else {
			await admin.query(`create database ${quote(name)}`);
		}
	});

	let dropped = false;
	return {
		name,
		url: urlFor(name),
		templateName,
		templateUrl: urlFor(templateName),
		async drop() {
			if (dropped) return;
			dropped = true;
			await withAdmin(async (admin) => {
				await admin.query(
					`drop database if exists ${quote(name)} with (force)`,
				);
			});
		},
	};
}
