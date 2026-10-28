import type { Socket, TCPSocketListener } from "bun";

export interface TcpProxy {
	/** Where the application connects instead of the database. */
	port: number;
	/** Refuses new connections and cuts the open ones, as a database that went away. */
	drop(): void;
	/** Accepts connections again on the same port. */
	restore(): void;
	/** Delay added to every chunk in each direction (ms); makes statements slow, deterministically. */
	setLatency(ms: number): void;
	connections(): number;
	stop(): void;
}

interface Link {
	upstream: Socket<Link> | undefined;
	queued: Uint8Array[];
}

/**
 * A TCP proxy between the application and the REAL PostgreSQL (I-20): the database stays up for
 * every other suite while this one pretends it is gone. `drop()` closes the listener (new
 * connections are refused) and terminates every open socket; `restore()` listens again.
 */
export async function startTcpProxy(
	targetHost: string,
	targetPort: number,
): Promise<TcpProxy> {
	const sockets = new Set<Socket<unknown>>();
	let listener: TCPSocketListener<Link> | undefined;
	let latencyMs = 0;
	let port = 0;

	const forward = (to: Socket<unknown>, chunk: Uint8Array): void => {
		// The copy is needed: Bun reuses the buffer behind `chunk` after the callback returns.
		const copy = chunk.slice();
		if (latencyMs === 0) {
			to.write(copy);
			return;
		}
		// Writing to a socket that was terminated meanwhile is a harmless no-op.
		setTimeout(() => to.write(copy), latencyMs);
	};

	const listen = (): TCPSocketListener<Link> =>
		Bun.listen<Link>({
			hostname: "127.0.0.1",
			port,
			socket: {
				async open(client) {
					sockets.add(client);
					client.data = { upstream: undefined, queued: [] };
					const upstream = await Bun.connect<Link>({
						hostname: targetHost,
						port: targetPort,
						data: client.data,
						socket: {
							open(up) {
								sockets.add(up);
							},
							data(_up, chunk) {
								forward(client, chunk);
							},
							close(up) {
								sockets.delete(up);
								client.end();
							},
							error(up) {
								sockets.delete(up);
								client.end();
							},
						},
					});
					client.data.upstream = upstream;
					for (const chunk of client.data.queued) forward(upstream, chunk);
					client.data.queued = [];
				},
				data(client, chunk) {
					const { upstream } = client.data;
					if (upstream === undefined) client.data.queued.push(chunk.slice());
					else forward(upstream, chunk);
				},
				close(client) {
					sockets.delete(client);
					client.data.upstream?.end();
				},
				error(client) {
					sockets.delete(client);
					client.data.upstream?.end();
				},
			},
		});

	listener = listen();
	port = listener.port;

	return {
		port,
		drop() {
			listener?.stop(true);
			listener = undefined;
			for (const socket of sockets) socket.terminate();
			sockets.clear();
		},
		restore() {
			if (listener === undefined) listener = listen();
		},
		setLatency(ms) {
			latencyMs = ms;
		},
		connections: () => sockets.size,
		stop() {
			listener?.stop(true);
			listener = undefined;
			for (const socket of sockets) socket.terminate();
			sockets.clear();
		},
	};
}
