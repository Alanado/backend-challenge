import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	Controller,
	Get,
	type INestApplication,
	type MiddlewareConsumer,
	Module,
	type NestModule,
} from "@nestjs/common";
import { APP_FILTER, NestFactory } from "@nestjs/core";
import { AppLogger } from "../../src/modules/platform/application/log-fields";
import {
	InfrastructureUnavailableError,
	TransientPersistenceError,
} from "../../src/modules/platform/application/persistence-errors";
import { CorrelationIdMiddleware } from "../../src/modules/platform/infrastructure/correlation-id.middleware";
import {
	createPinoLogger,
	PinoAppLogger,
} from "../../src/modules/platform/infrastructure/pino-logger";
import { ProblemDetailsFilter } from "../../src/modules/platform/infrastructure/problem-details.filter";

const logLines: string[] = [];
const logger = new PinoAppLogger(
	createPinoLogger({
		level: "info",
		destination: { write: (chunk: string) => void logLines.push(chunk) },
	}),
);

@Controller("boom")
class BoomController {
	@Get("lock-timeout")
	lockTimeout(): never {
		throw new TransientPersistenceError("lock_timeout");
	}

	@Get("deadlock")
	deadlock(): never {
		throw new TransientPersistenceError("deadlock");
	}

	@Get("unavailable")
	unavailable(): never {
		throw new InfrastructureUnavailableError();
	}

	@Get("bug")
	bug(): never {
		throw Object.assign(
			new Error("select * from wallets where player_id = 'leaky-player-uuid'"),
			{ detail: "Key (balance)=(777.00) is secret" },
		);
	}
}

@Module({
	controllers: [BoomController],
	providers: [
		{ provide: AppLogger, useValue: logger },
		CorrelationIdMiddleware,
		{ provide: APP_FILTER, useClass: ProblemDetailsFilter },
	],
})
class BoomModule implements NestModule {
	configure(consumer: MiddlewareConsumer): void {
		consumer.apply(CorrelationIdMiddleware).forRoutes("*");
	}
}

let app: INestApplication;
let base: string;

beforeAll(async () => {
	app = await NestFactory.create(BoomModule, { logger: false });
	await app.listen(0, "127.0.0.1");
	base = await app.getUrl();
});

afterAll(async () => {
	await app.close();
});

describe("TST-I-19 ProblemDetailsFilter (transient and internal errors, real HTTP)", () => {
	test.each([["lock-timeout"], ["deadlock"], ["unavailable"]])(
		"TST-I-19 %s is 503 SERVICE_UNAVAILABLE with Retry-After: 1",
		async (path) => {
			const response = await fetch(`${base}/boom/${path}`, {
				headers: { "X-Correlation-Id": "corr-503" },
			});

			expect(response.status).toBe(503);
			expect(response.headers.get("retry-after")).toBe("1");
			expect(response.headers.get("content-type")).toContain(
				"application/problem+json",
			);
			expect(await response.json()).toMatchObject({
				type: "about:blank",
				status: 503,
				errorCode: "SERVICE_UNAVAILABLE",
				correlationId: "corr-503",
				retryable: true,
			});
		},
	);

	test("TST-I-19 an unexpected error is 500 INTERNAL_ERROR and leaks nothing", async () => {
		const response = await fetch(`${base}/boom/bug`, {
			headers: { "X-Correlation-Id": "corr-500" },
		});

		expect(response.status).toBe(500);
		expect(response.headers.get("content-type")).toContain(
			"application/problem+json",
		);
		const text = await response.text();
		expect(JSON.parse(text)).toMatchObject({
			type: "about:blank",
			status: 500,
			errorCode: "INTERNAL_ERROR",
			correlationId: "corr-500",
			retryable: false,
		});
		for (const leak of [
			"select",
			"leaky-player-uuid",
			"777.00",
			"wallets",
			"Error:",
		]) {
			expect(text).not.toContain(leak);
		}
	});

	test("TST-I-19 the 500 is logged with errorCode and correlationId but without the driver detail", async () => {
		await fetch(`${base}/boom/bug`, {
			headers: { "X-Correlation-Id": "corr-500-log" },
		});

		const line = logLines
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.find(
				(l) => l.msg === "request failed" && l.correlationId === "corr-500-log",
			);
		expect(line).toMatchObject({ errorCode: "INTERNAL_ERROR", status: 500 });
		const all = logLines.join("");
		expect(all).not.toContain("777.00");
		expect(all).not.toContain("Key (balance)");
	});

	test("TST-I-19 an unknown route keeps Nest's default 404 body", async () => {
		const response = await fetch(`${base}/nothing-here`);
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ statusCode: 404 });
	});
});
