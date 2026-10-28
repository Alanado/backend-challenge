import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Controller, Get, type INestApplication, Module } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { AuthGuard } from "../../src/modules/platform/infrastructure/auth.guard";
import { MetricsController } from "../../src/modules/platform/infrastructure/metrics.controller";
import { PromMetrics } from "../../src/modules/platform/infrastructure/prom-metrics";
import { Public } from "../../src/modules/platform/infrastructure/public.decorator";

/** What a real guard would be: it denies everything that is not @Public. */
class DenyAllGuard extends AuthGuard {
	protected override authenticate(): boolean {
		return false;
	}
}

// Stands in for /health/* (W10) with the same decorator.
@Public()
@Controller("health")
class FakeHealthController {
	@Get("live")
	live(): { status: string } {
		return { status: "up" };
	}
}

@Controller("private")
class PrivateController {
	@Get()
	secret(): { secret: boolean } {
		return { secret: true };
	}
}

@Module({
	controllers: [MetricsController, FakeHealthController, PrivateController],
	providers: [PromMetrics, { provide: APP_GUARD, useClass: DenyAllGuard }],
})
class DenyAllModule {}

@Module({
	controllers: [MetricsController, PrivateController],
	providers: [PromMetrics, { provide: APP_GUARD, useClass: AuthGuard }],
})
class NoopModule {}

async function start(module: new () => object): Promise<{
	app: INestApplication;
	base: string;
}> {
	const app = await NestFactory.create(module, { logger: false });
	await app.listen(0, "127.0.0.1");
	return { app, base: await app.getUrl() };
}

describe("T-054 @Public keeps health and metrics open when the guard denies everything", () => {
	let app: INestApplication;
	let base: string;

	beforeAll(async () => {
		({ app, base } = await start(DenyAllModule));
	});
	afterAll(async () => {
		await app.close();
	});

	test("T-054 /metrics answers 200 although the guard denies all", async () => {
		expect((await fetch(`${base}/metrics`)).status).toBe(200);
	});

	test("T-054 a @Public controller (health) answers 200 although the guard denies all", async () => {
		const response = await fetch(`${base}/health/live`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "up" });
	});

	test("T-054 a route that is not @Public is refused (the denying guard really is on)", async () => {
		expect((await fetch(`${base}/private`)).status).toBe(403);
	});
});

describe("T-054 the no-op guard in the real wiring", () => {
	let app: INestApplication;
	let base: string;

	beforeAll(async () => {
		({ app, base } = await start(NoopModule));
	});
	afterAll(async () => {
		await app.close();
	});

	test("T-054 every route is reachable, with or without credentials", async () => {
		expect((await fetch(`${base}/private`)).status).toBe(200);
		expect(
			(
				await fetch(`${base}/private`, {
					headers: { Authorization: "Bearer anything", "X-Provider-Id": "x" },
				})
			).status,
		).toBe(200);
	});
});
