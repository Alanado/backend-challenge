import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { testInfra } from "../support/infra";
import { startTcpProxy } from "../support/tcp-proxy";

const target = new URL(testInfra.databaseUrl);
const proxyPromise = startTcpProxy(target.hostname, Number(target.port));

afterAll(async () => (await proxyPromise).stop());

function through(port: number): Client {
	const url = new URL(testInfra.databaseUrl);
	url.hostname = "127.0.0.1";
	url.port = String(port);
	return new Client({ connectionString: url.toString() });
}

describe("X-PROXY test TCP proxy in front of the real PostgreSQL", () => {
	test("X-PROXY forwards queries while up, refuses and cuts connections while dropped, and comes back", async () => {
		const proxy = await proxyPromise;

		const first = through(proxy.port);
		first.on("error", () => {}); // the cut below is announced as an error event as well
		await first.connect();
		expect((await first.query("select 1 as one")).rows[0]).toEqual({ one: 1 });

		proxy.drop();
		await expect(first.query("select 1")).rejects.toThrow();
		const refused = through(proxy.port);
		await expect(refused.connect()).rejects.toThrow();
		await first.end().catch(() => undefined);

		proxy.restore();
		const again = through(proxy.port);
		await again.connect();
		expect((await again.query("select 2 as two")).rows[0]).toEqual({ two: 2 });
		await again.end();

		// The database itself never went down: a direct connection works all along.
		const direct = new Client({ connectionString: testInfra.databaseUrl });
		await direct.connect();
		expect((await direct.query("select 3 as three")).rows[0]).toEqual({
			three: 3,
		});
		await direct.end();
	});
});
