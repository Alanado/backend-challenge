import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../../../src/shared/config";
import {
	createFaultInjector,
	FAULT_POINTS,
	InjectedFaultError,
	SimulatedCrashError,
} from "../../../src/shared/fault-injector";

const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db" };

describe("FaultInjector", () => {
	test("FLT-01 exposes exactly the three fixed fault points", () => {
		expect([...FAULT_POINTS]).toEqual([
			"crash-after-commit-before-ack",
			"crash-after-publish-before-commit",
			"fail-mid-transaction",
		]);
	});

	test("FLT-02 check is a no-op when nothing is configured", () => {
		const injector = createFaultInjector("");
		for (const point of FAULT_POINTS) {
			expect(() => injector.check(point)).not.toThrow();
		}
	});

	test("FLT-03 check is a no-op for points other than the configured one", () => {
		const injector = createFaultInjector("fail-mid-transaction");
		expect(() => injector.check("crash-after-commit-before-ack")).not.toThrow();
		expect(() =>
			injector.check("crash-after-publish-before-commit"),
		).not.toThrow();
	});

	test("FLT-04 fail-mid-transaction throws InjectedFaultError", () => {
		const injector = createFaultInjector("fail-mid-transaction");
		expect(() => injector.check("fail-mid-transaction")).toThrow(
			InjectedFaultError,
		);
	});

	test.each([
		"crash-after-commit-before-ack",
		"crash-after-publish-before-commit",
	] as const)("FLT-05 %s calls the injected crash function", (point) => {
		const crashed: string[] = [];
		const injector = createFaultInjector(point, (p) => {
			crashed.push(p);
		});
		injector.check(point);
		expect(crashed).toEqual([point]);
	});

	test("FLT-06 a crash function that throws SimulatedCrashError propagates it", () => {
		const injector = createFaultInjector(
			"crash-after-commit-before-ack",
			(p) => {
				throw new SimulatedCrashError(p);
			},
		);
		expect(() => injector.check("crash-after-commit-before-ack")).toThrow(
			SimulatedCrashError,
		);
	});

	test("FLT-07 the default crash function kills the process (exit code 137)", async () => {
		const script = `
			import { createFaultInjector } from "./src/shared/fault-injector";
			createFaultInjector("crash-after-commit-before-ack").check("crash-after-commit-before-ack");
			console.log("survived");
		`;
		const proc = Bun.spawn(["bun", "-e", script], {
			cwd: process.cwd(),
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		expect(exitCode).toBe(137);
		expect(await new Response(proc.stdout).text()).not.toContain("survived");
	});

	test("FLT-08 rejects an unknown fault point", () => {
		expect(() => createFaultInjector("explode")).toThrow(/explode/);
	});
});

describe("config TEST_FAULT", () => {
	test("CFG-TF-01 accepts each known fault point outside production", () => {
		for (const point of FAULT_POINTS) {
			expect(loadConfig({ ...base, TEST_FAULT: point }).testFault).toBe(point);
		}
	});

	test("CFG-TF-02 rejects an unknown value naming the variable", () => {
		expect(() => loadConfig({ ...base, TEST_FAULT: "explode" })).toThrow(
			/TEST_FAULT/,
		);
	});

	test.each(FAULT_POINTS)(
		"CFG-TF-03 refuses TEST_FAULT=%s when NODE_ENV=production",
		(point) => {
			let error: unknown;
			try {
				loadConfig({ ...base, NODE_ENV: "production", TEST_FAULT: point });
			} catch (err) {
				error = err;
			}
			expect(error).toBeInstanceOf(ConfigError);
			expect((error as ConfigError).message).toContain("TEST_FAULT");
			expect((error as ConfigError).message).toContain("production");
		},
	);

	test("CFG-TF-04 an empty TEST_FAULT is fine in production", () => {
		const config = loadConfig({
			...base,
			NODE_ENV: "production",
			TEST_FAULT: "",
		});
		expect(config.testFault).toBe("");
	});

	test("CFG-TF-05 an unknown TEST_FAULT is also refused in production", () => {
		expect(() =>
			loadConfig({ ...base, NODE_ENV: "production", TEST_FAULT: "explode" }),
		).toThrow(/TEST_FAULT/);
	});
});
