import { Migrator } from "@mikro-orm/migrations";
import { MikroORM } from "@mikro-orm/postgresql";

// Uso: bun run scripts/migrate.ts <up|down|create> [nome]
// DATABASE_URL e MIGRATIONS_PATH (padrão src/migrations) vêm do ambiente.
const command = process.argv[2];
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const orm = await MikroORM.init({
	clientUrl: url,
	entities: [],
	discovery: { warnWhenNoEntities: false },
	extensions: [Migrator],
	migrations: {
		path: process.env.MIGRATIONS_PATH ?? "src/migrations",
		glob: "!(*.d).{js,ts}",
		transactional: true,
		allOrNothing: true,
		snapshot: false,
	},
});

try {
	const migrator = orm.migrator;
	if (command === "up") {
		const done = await migrator.up();
		console.log(`applied: ${done.map((m) => m.name).join(", ") || "(none)"}`);
	} else if (command === "down") {
		const done = await migrator.down();
		console.log(`reverted: ${done.map((m) => m.name).join(", ") || "(none)"}`);
	} else if (command === "create") {
		const created = await migrator.create(process.argv[3], true);
		console.log(`created: ${created.fileName}`);
	} else {
		throw new Error(
			`unknown command: ${command ?? "(none)"} (use up|down|create)`,
		);
	}
} finally {
	await orm.close(true);
}
