/**
 * Runs `tick` again and again until `stop()`. `tick` answers whether it found work: if so the
 * next tick starts at once, otherwise the loop sleeps `pollMs`. A tick that throws is reported to
 * `onError` and the loop carries on after the same pause. `stop()` never interrupts a tick: it
 * resolves once the one in progress has finished (graceful stop of publisher and worker).
 */
export class PollingLoop {
	private running: Promise<void> | undefined;
	private stopped = false;
	private wake: (() => void) | undefined;

	constructor(
		private readonly tick: () => Promise<boolean>,
		private readonly pollMs: number,
		private readonly onError: (error: unknown) => void,
	) {}

	start(): void {
		if (this.running !== undefined) return;
		this.stopped = false;
		this.running = this.run();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.wake?.();
		await this.running;
		this.running = undefined;
	}

	private async run(): Promise<void> {
		while (!this.stopped) {
			let didWork = false;
			try {
				didWork = await this.tick();
			} catch (error) {
				this.onError(error);
			}
			if (!didWork && !this.stopped) await this.sleep();
		}
	}

	private sleep(): Promise<void> {
		return new Promise((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				this.wake = undefined;
				resolve();
			};
			const timer = setTimeout(finish, this.pollMs);
			this.wake = finish;
		});
	}
}
