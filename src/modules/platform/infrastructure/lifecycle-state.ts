import { Injectable } from "@nestjs/common";

export type LifecyclePhase = "accepting" | "draining";

/**
 * Where this instance is in its life (03-messaging §8). It starts `accepting` and only moves
 * forward: `drain()` is what the shutdown sequence calls first, so readiness fails before anything
 * is closed and the load balancer stops sending traffic while in-flight work finishes.
 */
@Injectable()
export class LifecycleState {
	private current: LifecyclePhase = "accepting";

	phase(): LifecyclePhase {
		return this.current;
	}

	isDraining(): boolean {
		return this.current === "draining";
	}

	drain(): void {
		this.current = "draining";
	}
}
