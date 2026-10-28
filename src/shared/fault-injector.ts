/** The only fault points of the test seam (03-messaging §9). Adding one needs an ADR. */
export const FAULT_POINTS = [
	"crash-after-commit-before-ack",
	"crash-after-publish-before-commit",
	"fail-mid-transaction",
] as const;

export type FaultPoint = (typeof FAULT_POINTS)[number];

export function isFaultPoint(value: string): value is FaultPoint {
	return (FAULT_POINTS as readonly string[]).includes(value);
}

export class InjectedFaultError extends Error {
	constructor(readonly point: FaultPoint) {
		super(`injected fault at ${point}`);
		this.name = "InjectedFaultError";
	}
}

/** What in-process tests throw instead of killing the test runner. */
export class SimulatedCrashError extends Error {
	constructor(readonly point: FaultPoint) {
		super(`simulated crash at ${point}`);
		this.name = "SimulatedCrashError";
	}
}

export interface FaultInjector {
	/** No-op unless `point` is the configured one. */
	check(point: FaultPoint): void;
}

export type CrashFn = (point: FaultPoint) => void;

/** Default crash: SIGKILL to self, so no shutdown handler, finally block or ack gets to run. */
export const killProcess: CrashFn = () => {
	process.kill(process.pid, "SIGKILL");
};

export function createFaultInjector(
	configured: string,
	crash: CrashFn = killProcess,
): FaultInjector {
	if (configured !== "" && !isFaultPoint(configured)) {
		throw new Error(`unknown fault point: ${configured}`);
	}
	return {
		check(point) {
			if (point !== configured) return;
			if (point === "fail-mid-transaction") throw new InjectedFaultError(point);
			crash(point);
		},
	};
}
