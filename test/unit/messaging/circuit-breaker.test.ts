import { describe, expect, test } from "bun:test";
import { CircuitBreaker } from "../../../src/modules/messaging/application/circuit-breaker";
import { RecordingMetrics, SteppingClock } from "../../support/submit-harness";

function setup(options: { min?: number; max?: number } = {}) {
	const clock = new SteppingClock();
	const metrics = new RecordingMetrics();
	let probes = 0;
	let databaseUp = false;
	let probeGate: Promise<void> | undefined;
	const breaker = new CircuitBreaker({
		clock,
		cooldownMinMs: options.min ?? 1000,
		cooldownMaxMs: options.max ?? 30_000,
		metrics,
		probe: async () => {
			probes += 1;
			await probeGate;
			if (!databaseUp) throw new Error("connection refused");
		},
	});
	return {
		clock,
		metrics,
		breaker,
		probes: () => probes,
		setDatabase(up: boolean) {
			databaseUp = up;
		},
		holdProbe(): () => void {
			let release!: () => void;
			probeGate = new Promise<void>((resolve) => {
				release = resolve;
			});
			return () => {
				probeGate = undefined;
				release();
			};
		},
	};
}

describe("X-BREAKER circuit breaker state machine", () => {
	test("X-BREAKER starts closed: requests are allowed and nothing is probed", async () => {
		const t = setup();
		expect(t.breaker.isOpen()).toBe(false);
		expect(await t.breaker.allowRequests()).toBe(true);
		expect(t.probes()).toBe(0);
		expect(t.metrics.breakerStates).toEqual([]);
	});

	test("X-BREAKER an infrastructure failure opens it, sets the gauge, and blocks requests during the cooldown", async () => {
		const t = setup();
		t.breaker.reportFailure();

		expect(t.breaker.isOpen()).toBe(true);
		expect(t.metrics.breakerStates).toEqual([true]);
		expect(await t.breaker.allowRequests()).toBe(false);
		t.clock.advance(999);
		expect(await t.breaker.allowRequests()).toBe(false);
		expect(t.probes()).toBe(0); // no probe before the cooldown ends
	});

	test("X-BREAKER after the cooldown a passing probe closes it (half-open → closed)", async () => {
		const t = setup();
		t.setDatabase(true);
		t.breaker.reportFailure();
		t.clock.advance(1000);

		expect(await t.breaker.allowRequests()).toBe(true);

		expect(t.probes()).toBe(1);
		expect(t.breaker.isOpen()).toBe(false);
		expect(t.metrics.breakerStates).toEqual([true, false]);
	});

	test("X-BREAKER a failing probe reopens it with a doubled cooldown (half-open → open)", async () => {
		const t = setup();
		t.breaker.reportFailure();

		t.clock.advance(1000);
		expect(await t.breaker.allowRequests()).toBe(false);
		expect(t.probes()).toBe(1);
		expect(t.breaker.isOpen()).toBe(true);

		// The second cooldown is 2000 ms, counted from the failed probe.
		t.clock.advance(1999);
		expect(await t.breaker.allowRequests()).toBe(false);
		expect(t.probes()).toBe(1);
		t.clock.advance(1);
		expect(await t.breaker.allowRequests()).toBe(false);
		expect(t.probes()).toBe(2);
		// The gauge never dropped to 0 while it stayed open.
		expect(t.metrics.breakerStates).toEqual([true]);
	});

	test("X-BREAKER the cooldown doubles up to the cap and stays there", async () => {
		const t = setup({ min: 1000, max: 5000 });
		t.breaker.reportFailure();
		const cooldowns: number[] = [];
		for (let i = 0; i < 5; i++) {
			// find the length of this cooldown by probing just before and at its end
			let waited = 0;
			const before = t.probes();
			while (t.probes() === before && waited < 10_000) {
				t.clock.advance(250);
				waited += 250;
				await t.breaker.allowRequests();
			}
			cooldowns.push(waited);
		}
		expect(cooldowns).toEqual([1000, 2000, 4000, 5000, 5000]);
	});

	test("X-BREAKER closing resets the escalation: the next opening starts at the minimum again", async () => {
		const t = setup();
		t.breaker.reportFailure();
		t.clock.advance(1000);
		await t.breaker.allowRequests(); // fails: cooldown is now 2000
		t.setDatabase(true);
		t.clock.advance(2000);
		expect(await t.breaker.allowRequests()).toBe(true);

		t.breaker.reportFailure();
		t.clock.advance(1000);
		const probesBefore = t.probes();
		await t.breaker.allowRequests();
		expect(t.probes()).toBe(probesBefore + 1); // probed after 1000 ms, not 2000
	});

	test("X-BREAKER failures reported while it is already open neither escalate nor restart the cooldown", async () => {
		const t = setup();
		t.breaker.reportFailure();
		t.clock.advance(600);
		t.breaker.reportFailure(); // a handler that was already in flight
		t.breaker.reportFailure();
		t.clock.advance(400);

		t.setDatabase(true);
		expect(await t.breaker.allowRequests()).toBe(true);
		expect(t.metrics.breakerStates).toEqual([true, false]);
	});

	test("X-BREAKER while a probe is running other callers are refused and no second probe starts", async () => {
		const t = setup();
		t.setDatabase(true);
		t.breaker.reportFailure();
		t.clock.advance(1000);
		const release = t.holdProbe();

		const first = t.breaker.allowRequests();
		expect(await t.breaker.allowRequests()).toBe(false);
		expect(t.probes()).toBe(1);

		release();
		expect(await first).toBe(true);
		expect(t.breaker.isOpen()).toBe(false);
	});

	test("X-BREAKER a probe that never answers counts as a failure after its timeout", async () => {
		const clock = new SteppingClock();
		const metrics = new RecordingMetrics();
		const breaker = new CircuitBreaker({
			clock,
			cooldownMinMs: 1000,
			cooldownMaxMs: 30_000,
			metrics,
			probeTimeoutMs: 20,
			probe: () => new Promise<void>(() => {}),
		});
		breaker.reportFailure();
		clock.advance(1000);

		expect(await breaker.allowRequests()).toBe(false);
		expect(breaker.isOpen()).toBe(true);
	});
});
