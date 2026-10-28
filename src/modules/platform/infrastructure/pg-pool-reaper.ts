/*
 * Workaround for a leak in MikroORM 7.2.5 / Kysely: when the connection of an open transaction dies
 * (server killed the backend, restart, network drop), the ROLLBACK fails and Kysely skips releasing
 * the connection, so the pg pool keeps the slot checked out forever. With DB_POOL_MAX such
 * transactions in flight during an outage the app can never get a connection again, which would
 * defeat the recovery of the circuit breaker (ADR-0015).
 *
 * The pg client of a dead connection is flagged by pg itself (`_queryable = false` / `_ending`);
 * releasing it with an error makes pg-pool drop it and refill later. These members are private to
 * pg / pg-pool, hence the structural types and the strict guards. Covered by TST X-21; drop this
 * file when the upstream release returns the connection on a failed ROLLBACK.
 */
interface PoolClientLike {
	_queryable?: boolean;
	_ending?: boolean;
	release?: (error?: Error | boolean) => void;
}

interface PoolLike {
	_clients?: PoolClientLike[];
	_idle?: { client: PoolClientLike }[];
}

function isPoolLike(value: unknown): value is PoolLike {
	return (
		typeof value === "object" &&
		value !== null &&
		Array.isArray((value as PoolLike)._clients)
	);
}

/** Releases (discarding) every checked-out client whose connection is already dead. Returns how many. */
export function releaseDeadClients(pool: unknown): number {
	if (!isPoolLike(pool) || pool._clients === undefined) return 0;
	const idle = new Set((pool._idle ?? []).map((item) => item.client));
	let released = 0;
	for (const client of [...pool._clients]) {
		const dead = client._queryable === false || client._ending === true;
		if (!dead || idle.has(client) || typeof client.release !== "function") {
			continue;
		}
		try {
			client.release(true);
			released += 1;
		} catch {
			// Already released by someone else: nothing left to reclaim.
		}
	}
	return released;
}
