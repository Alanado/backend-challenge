import { eventually } from "./eventually";

export interface AppProcess {
	readonly proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	stdout(): string;
	stderr(): string;
	/** Resolves with the exit code once the process is gone. */
	exited: Promise<number>;
	waitForStdout(text: string, timeout?: number): Promise<void>;
	stop(): Promise<void>;
}

function collect(stream: ReadableStream<Uint8Array>): () => string {
	let text = "";
	const decoder = new TextDecoder();
	void (async () => {
		for await (const chunk of stream) text += decoder.decode(chunk);
	})();
	return () => text;
}

/** Starts the real application (`bun src/main.ts`) as a child process with exactly `env`. */
export function spawnApp(env: Record<string, string>): AppProcess {
	const proc = Bun.spawn([process.execPath, "src/main.ts"], {
		cwd: `${import.meta.dir}/../..`,
		env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = collect(proc.stdout);
	const stderr = collect(proc.stderr);
	return {
		proc,
		stdout,
		stderr,
		exited: proc.exited,
		async waitForStdout(text, timeout = 15_000) {
			await eventually(
				() => {
					if (!stdout().includes(text)) {
						throw new Error(
							`"${text}" not in stdout yet (exit=${proc.exitCode}); stdout=${stdout()} stderr=${stderr()}`,
						);
					}
				},
				{ timeout, interval: 50 },
			);
		},
		async stop() {
			if (proc.exitCode === null) {
				proc.kill("SIGKILL");
				await proc.exited;
			}
		},
	};
}

/** A TCP port that was free a moment ago. */
export async function freePort(): Promise<number> {
	const server = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: { data() {} },
	});
	const { port } = server;
	server.stop(true);
	return port;
}
