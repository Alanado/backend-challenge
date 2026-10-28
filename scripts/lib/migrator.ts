import type { IMigrator } from "@mikro-orm/core";
import { Migrator } from "@mikro-orm/migrations";
import { MikroORM } from "@mikro-orm/postgresql";

export const DEFAULT_MIGRATIONS_PATH = "src/migrations";

/** Opens a MikroORM wired to the migrator only (no entities), runs `work`, always closes it. */
export async function withMigrator<T>(
	url: string,
	path: string,
	work: (migrator: IMigrator) => Promise<T>,
	{ silent = false }: { silent?: boolean } = {},
): Promise<T> {
	const orm = await MikroORM.init({
		clientUrl: url,
		entities: [],
		discovery: { warnWhenNoEntities: false },
		extensions: [Migrator],
		migrations: {
			path,
			glob: "!(*.d).{js,ts}",
			transactional: true,
			allOrNothing: true,
			snapshot: false,
			silent,
		},
	});
	try {
		return await work(orm.migrator);
	} finally {
		await orm.close(true);
	}
}
