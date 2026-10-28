import "reflect-metadata";
import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { appModule } from "./app.module";
import { ActiveRoles } from "./modules/platform/infrastructure/active-roles";
import { type AppConfig, ConfigError, loadConfig } from "./shared/config";

// Boot/stop lines (event names and role names only; no values) stay as plain JSON lines: `roles`
// and `port` are deliberately not among the log fields, and nothing sensitive is in them.
const emit = (event: string, fields: Record<string, unknown> = {}): void => {
	console.log(JSON.stringify({ event, ...fields }));
};

// The process ends by itself once everything is closed (pool, server, keep-alive timer), which
// is the proof that shutdown left nothing behind; `exitCode` carries the verdict.
function readConfig(): AppConfig | undefined {
	try {
		return loadConfig(process.env);
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		console.error(error.message);
		process.exitCode = 1;
		return undefined;
	}
}

async function main(): Promise<void> {
	const config = readConfig();
	if (config === undefined) return;
	const module = appModule(config);

	// Without the HTTP role there is no server at all: the app is a plain context.
	const http = config.enableHttp
		? await NestFactory.create(module, { bufferLogs: true })
		: undefined;
	const app: INestApplicationContext =
		http ??
		(await NestFactory.createApplicationContext(module, { bufferLogs: true }));
	// Nest's own messages go through the same pino (redaction, level from LOG_LEVEL).
	app.useLogger(app.get(Logger));
	// No server and (until the roles gain content) nothing else holding the event loop.
	const keepAlive =
		http === undefined ? setInterval(() => {}, 2 ** 30) : undefined;

	// `app.enableShutdownHooks()` is deliberately not used: after closing, Nest re-sends the
	// signal to the process, which then ends with 143 instead of 0. `app.close()` runs the very
	// same OnModuleDestroy / OnApplicationShutdown hooks (pool closed, roles stopped).
	let stopping = false;
	const stop = async (signal: string): Promise<void> => {
		if (stopping) return;
		stopping = true;
		clearInterval(keepAlive);
		try {
			await app.close();
			emit("app_stopped", { signal });
		} catch (error) {
			console.error("shutdown failed", error);
			process.exitCode = 1;
		}
	};
	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		process.once(signal, () => void stop(signal));
	}

	try {
		if (http === undefined) await app.init();
		else await http.listen(config.port);
	} catch (error) {
		clearInterval(keepAlive);
		await app.close().catch(() => undefined);
		throw error;
	}
	emit("app_started", {
		roles: app.get(ActiveRoles).list(),
		...(http === undefined ? {} : { port: config.port }),
	});
}

main().catch((error: unknown) => {
	console.error("fatal: could not start", error);
	process.exitCode = 1;
});
