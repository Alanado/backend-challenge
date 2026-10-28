// Spike R-04/R-05 (T-004): prom-client, Biome (noFloatingPromises / useImportType) e commitlint sob Bun.
import {
	Counter,
	collectDefaultMetrics,
	Gauge,
	Histogram,
	Registry,
} from "prom-client";
import { assert, check, finish, note } from "../lib/check";

await check(
	"1a",
	"prom-client: counter, gauge e histogram com labels em GET /metrics",
	async () => {
		const registry = new Registry();
		const requests = new Counter({
			name: "spike_requests_total",
			help: "requests",
			labelNames: ["status", "kind"],
			registers: [registry],
		});
		const lag = new Gauge({
			name: "spike_outbox_lag",
			help: "lag",
			registers: [registry],
		});
		const latency = new Histogram({
			name: "spike_latency_seconds",
			help: "latency",
			labelNames: ["channel"],
			buckets: [0.01, 0.1, 1],
			registers: [registry],
		});
		requests.inc({ status: "COMPLETED", kind: "WAGER" }, 3);
		lag.set(7);
		latency.observe({ channel: "http" }, 0.05);
		latency.observe({ channel: "http" }, 0.5);

		const server = Bun.serve({
			port: 0,
			fetch: async (req) =>
				new URL(req.url).pathname === "/metrics"
					? new Response(await registry.metrics(), {
							headers: { "content-type": registry.contentType },
						})
					: new Response("not found", { status: 404 }),
		});
		try {
			const res = await fetch(`http://localhost:${server.port}/metrics`);
			const text = await res.text();
			assert(res.status === 200, `status ${res.status}`);
			assert(
				res.headers.get("content-type")?.startsWith("text/plain"),
				`content-type ${res.headers.get("content-type")}`,
			);
			assert(
				text.includes(
					'spike_requests_total{status="COMPLETED",kind="WAGER"} 3',
				),
				"counter com labels",
			);
			assert(text.includes("spike_outbox_lag 7"), "gauge");
			assert(
				text.includes(
					'spike_latency_seconds_bucket{le="0.1",channel="http"} 1',
				),
				"histogram bucket 0.1",
			);
			assert(
				text.includes('spike_latency_seconds_bucket{le="1",channel="http"} 2'),
				"histogram bucket 1",
			);
			assert(
				text.includes('spike_latency_seconds_count{channel="http"} 2'),
				"histogram count",
			);
			assert(
				text.includes('spike_latency_seconds_sum{channel="http"} 0.55'),
				"histogram sum",
			);
			return "counter/gauge/histogram com labels servidos em /metrics";
		} finally {
			await server.stop(true);
		}
	},
);

await check(
	"1b",
	"prom-client: métricas padrão do Node funcionam no Bun?",
	async () => {
		const registry = new Registry();
		collectDefaultMetrics({ register: registry });
		await new Promise((resolve) => setTimeout(resolve, 200));
		const names = (await registry.getMetricsAsJSON()).map((m) => m.name);
		const expected = [
			"process_cpu_user_seconds_total",
			"process_resident_memory_bytes",
			"process_start_time_seconds",
			"process_open_fds",
			"nodejs_eventloop_lag_seconds",
			"nodejs_heap_size_used_bytes",
			"nodejs_active_handles_total",
			"nodejs_gc_duration_seconds",
			"nodejs_version_info",
		];
		const present = expected.filter((n) => names.includes(n));
		const missing = expected.filter((n) => !names.includes(n));
		note(
			`default metrics: ${names.length} séries; ausentes: ${missing.join(", ") || "nenhuma"}`,
		);
		assert(names.length > 0, "collectDefaultMetrics não registrou nada");
		return `${names.length} séries; presentes ${present.length}/${expected.length}; ausentes: ${missing.join(", ") || "nenhuma"}`;
	},
);

async function bunTest(
	file: string,
): Promise<{ ok: boolean; summary: string }> {
	const proc = Bun.spawn(["bun", "test", file], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const text = out + err;
	const pass = /(\d+) pass/.exec(text)?.[1] ?? "?";
	const fail = /(\d+) fail/.exec(text)?.[1] ?? "?";
	return {
		ok: code === 0,
		summary: `${pass} pass / ${fail} fail${code === 0 ? "" : `\n${text}`}`,
	};
}

await check(
	"2",
	"Biome: noFloatingPromises ativa (nursery) e falha o lint do fixture; useImportType desligada",
	async () => {
		const result = await bunTest("test/unit/tooling/lint-rules.test.ts");
		assert(result.ok, result.summary);
		const config = await Bun.file("biome.jsonc").text();
		assert(
			config.includes('"noFloatingPromises": "error"'),
			"biome.jsonc sem noFloatingPromises=error",
		);
		assert(
			config.includes('"useImportType": "off"'),
			"biome.jsonc sem useImportType=off",
		);
		return `lint-rules.test.ts: ${result.summary}`;
	},
);

await check(
	"3",
	"commitlint sob Bun: hook rejeita inválida e aceita válida (PT-BR com acentos)",
	async () => {
		const result = await bunTest("test/unit/tooling/commit-msg-hook.test.ts");
		assert(result.ok, result.summary);
		const hooksPath = Bun.spawnSync(["git", "config", "core.hooksPath"])
			.stdout.toString()
			.trim();
		assert(
			hooksPath === ".githooks",
			`core.hooksPath=${hooksPath || "(vazio)"}; rode bun run hooks:install`,
		);
		return `commit-msg-hook.test.ts: ${result.summary}; core.hooksPath=${hooksPath}`;
	},
);

finish("spike:tooling");
