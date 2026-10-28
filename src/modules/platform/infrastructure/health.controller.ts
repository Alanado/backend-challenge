import {
	Controller,
	Get,
	Injectable,
	ServiceUnavailableException,
} from "@nestjs/common";
import { InfrastructureProbe } from "../application/infrastructure-probe";
import { LifecycleState } from "./lifecycle-state";
import { Public } from "./public.decorator";
import { type ReadinessCheck, ReadinessRegistry } from "./readiness-registry";

/** Each dependency check gets this long (ADR-0018); a hung one counts as down. */
export const READINESS_TIMEOUT_MS = 2000;

type Verdict = "up" | "down";

async function runWithTimeout(
	check: ReadinessCheck,
	timeoutMs: number,
): Promise<Verdict> {
	const abort = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			abort.abort();
			reject(new Error("readiness check timed out"));
		}, timeoutMs);
	});
	try {
		await Promise.race([Promise.resolve(check(abort.signal)), timedOut]);
		return "up";
	} catch {
		return "down";
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Own implementation, no `@nestjs/terminus` (ADR-0018). The answers carry only the name of each
 * check and `up`/`down`: no host, queue url or error text leaves the instance.
 */
@Injectable()
@Public()
@Controller("health")
export class HealthController {
	constructor(
		private readonly probe: InfrastructureProbe,
		private readonly lifecycle: LifecycleState,
		private readonly registry: ReadinessRegistry,
	) {}

	/** Liveness: the process answers. Touches no dependency, so an outage never restarts it. */
	@Get("live")
	live(): { status: "up" } {
		return { status: "up" };
	}

	@Get("ready")
	async ready(): Promise<{ status: "up"; checks: Record<string, Verdict> }> {
		const named: Array<[string, ReadinessCheck]> = [
			["database", () => this.probe.ping()],
			[
				"lifecycle",
				() => {
					if (this.lifecycle.isDraining()) throw new Error("draining");
				},
			],
			...this.registry.checks(),
		];
		const verdicts = await Promise.all(
			named.map(
				async ([name, check]) =>
					[name, await runWithTimeout(check, READINESS_TIMEOUT_MS)] as const,
			),
		);
		const checks = Object.fromEntries(verdicts);
		if (verdicts.some(([, verdict]) => verdict === "down")) {
			throw new ServiceUnavailableException({ status: "down", checks });
		}
		return { status: "up", checks };
	}
}
