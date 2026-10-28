import { Injectable } from "@nestjs/common";

/** A readiness check resolves when its dependency is fine and rejects (or throws) when it is not. */
export type ReadinessCheck = (signal: AbortSignal) => Promise<void> | void;

/**
 * What `GET /health/ready` asks besides the database. Each role that owns a dependency (the
 * consumer: input queue and circuit breaker; the publisher: events queue) registers it on start,
 * so the readiness of an instance is exactly the needs of the roles it runs, and the HTTP role
 * needs no knowledge of the others.
 */
@Injectable()
export class ReadinessRegistry {
	private readonly registered = new Map<string, ReadinessCheck>();

	add(name: string, check: ReadinessCheck): void {
		this.registered.set(name, check);
	}

	checks(): ReadonlyMap<string, ReadinessCheck> {
		return this.registered;
	}
}
