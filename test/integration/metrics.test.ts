import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NoopMetrics } from "../../src/modules/platform/application/metrics";
import { PromMetrics } from "../../src/modules/platform/infrastructure/prom-metrics";
import { type AppProcess, freePort, spawnApp } from "../support/app-process";
import {
	createSuiteDatabase,
	type SuiteDatabase,
} from "../support/suite-database";

const EXPECTED_TYPES: Record<string, string> = {
	wager_transactions_total: "counter",
	idempotent_requests_total: "counter",
	retries_total: "counter",
	dlq_messages_total: "counter",
	lock_conflicts_total: "counter",
	outbox_lag_seconds: "gauge",
	outbox_publish_failed_total: "counter",
	processing_duration_seconds: "histogram",
	reconciliation_divergences_total: "counter",
	circuit_breaker_open: "gauge",
};

function typesOf(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const match of text.matchAll(/^# TYPE (\S+) (\S+)$/gm)) {
		out[match[1] ?? ""] = match[2] ?? "";
	}
	return out;
}

/** Value of the sample line starting with `name{labels}` (labels as written by prom-client). */
function sample(text: string, selector: string): number | undefined {
	for (const line of text.split("\n")) {
		if (line.startsWith(`${selector} `)) {
			return Number(line.slice(selector.length + 1));
		}
	}
	return undefined;
}

describe("TST-I-17 GET /metrics on the real app", () => {
	let db: SuiteDatabase;
	let app: AppProcess;
	let base: string;

	beforeAll(async () => {
		db = await createSuiteDatabase();
		const port = await freePort();
		base = `http://127.0.0.1:${port}`;
		app = spawnApp({ DATABASE_URL: db.url, PORT: String(port) });
		await app.waitForStdout("app_started");
	});

	afterAll(async () => {
		await app.stop();
		await db.drop();
	});

	test("TST-I-17 exposes the ten metrics with the right types, in Prometheus text format", async () => {
		const response = await fetch(`${base}/metrics`);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain(
			"text/plain; version=0.0.4",
		);
		const types = typesOf(await response.text());
		for (const [name, type] of Object.entries(EXPECTED_TYPES)) {
			expect(types[name]).toBe(type);
		}
	});

	test("TST-I-17 /metrics is open: no credentials needed, any correlation id echoed", async () => {
		const response = await fetch(`${base}/metrics`, {
			headers: { "X-Correlation-Id": "metrics-corr" },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("x-correlation-id")).toBe("metrics-corr");
	});
});

describe("TST-I-17 the Prometheus adapter", () => {
	test("TST-I-17 declares exactly the ten metrics, no more", async () => {
		const text = await new PromMetrics().render();
		expect(typesOf(text)).toEqual(EXPECTED_TYPES);
	});

	test("TST-I-17 counters increment with the exact label sets", async () => {
		const metrics = new PromMetrics();
		metrics.transactionProcessed({
			status: "PROCESSED",
			kind: "BET",
			channel: "http",
		});
		metrics.transactionProcessed({
			status: "PROCESSED",
			kind: "BET",
			channel: "http",
		});
		metrics.transactionProcessed({
			status: "REJECTED",
			kind: "BET",
			channel: "sqs",
			failureCode: "INSUFFICIENT_FUNDS",
		});
		metrics.idempotentRequest("replay", "http");
		metrics.idempotentRequest("conflict", "sqs");
		metrics.retry("consumer");
		metrics.retry("outbox");
		metrics.retry("pending_reference");
		metrics.dlqMessage("max_receive");
		metrics.lockConflict("lock_timeout");
		metrics.lockConflict("deadlock");
		metrics.lockConflict("version_assert");
		metrics.outboxPublishFailed();
		metrics.reconciliationDivergence();

		const text = await metrics.render();

		// failure_code carries the neutral value "none" when there is no rejection.
		expect(
			sample(
				text,
				'wager_transactions_total{status="PROCESSED",kind="BET",channel="http",failure_code="none"}',
			),
		).toBe(2);
		expect(
			sample(
				text,
				'wager_transactions_total{status="REJECTED",kind="BET",channel="sqs",failure_code="INSUFFICIENT_FUNDS"}',
			),
		).toBe(1);
		expect(
			sample(
				text,
				'idempotent_requests_total{outcome="replay",channel="http"}',
			),
		).toBe(1);
		expect(
			sample(
				text,
				'idempotent_requests_total{outcome="conflict",channel="sqs"}',
			),
		).toBe(1);
		for (const component of ["consumer", "outbox", "pending_reference"]) {
			expect(sample(text, `retries_total{component="${component}"}`)).toBe(1);
		}
		expect(sample(text, 'dlq_messages_total{reason="max_receive"}')).toBe(1);
		for (const type of ["lock_timeout", "deadlock", "version_assert"]) {
			expect(sample(text, `lock_conflicts_total{type="${type}"}`)).toBe(1);
		}
		expect(sample(text, "outbox_publish_failed_total")).toBe(1);
		expect(sample(text, "reconciliation_divergences_total")).toBe(1);
	});

	test("TST-I-17 gauges are set, not accumulated", async () => {
		const metrics = new PromMetrics();
		metrics.setOutboxLagSeconds(12.5);
		metrics.setOutboxLagSeconds(3);
		metrics.setCircuitBreakerOpen(true);
		let text = await metrics.render();
		expect(sample(text, "outbox_lag_seconds")).toBe(3);
		expect(sample(text, "circuit_breaker_open")).toBe(1);

		metrics.setCircuitBreakerOpen(false);
		text = await metrics.render();
		expect(sample(text, "circuit_breaker_open")).toBe(0);
	});

	test("TST-I-17 the histogram has millisecond-resolution buckets in seconds", async () => {
		const metrics = new PromMetrics();
		const labels = {
			channel: "http",
			kind: "BET",
			outcome: "PROCESSED",
		} as const;
		metrics.observeProcessingDuration(0.004, labels);
		metrics.observeProcessingDuration(0.3, labels);

		const text = await metrics.render();
		const base = 'channel="http",kind="BET",outcome="PROCESSED"';

		expect(sample(text, `processing_duration_seconds_count{${base}}`)).toBe(2);
		expect(
			sample(text, `processing_duration_seconds_sum{${base}}`),
		).toBeCloseTo(0.304, 6);
		expect(
			sample(text, `processing_duration_seconds_bucket{le="0.001",${base}}`),
		).toBe(0);
		expect(
			sample(text, `processing_duration_seconds_bucket{le="0.005",${base}}`),
		).toBe(1);
		expect(
			sample(text, `processing_duration_seconds_bucket{le="0.5",${base}}`),
		).toBe(2);
		expect(
			sample(text, `processing_duration_seconds_bucket{le="+Inf",${base}}`),
		).toBe(2);
	});

	test("TST-I-17 no metric carries walletId, playerId or transactionId as a label", async () => {
		const metrics = new PromMetrics();
		metrics.transactionProcessed({
			status: "PROCESSED",
			kind: "WIN",
			channel: "http",
		});
		metrics.observeProcessingDuration(0.01, {
			channel: "sqs",
			kind: "WIN",
			outcome: "PROCESSED",
		});
		const text = await metrics.render();
		for (const forbidden of [
			"walletId",
			"wallet_id",
			"playerId",
			"player_id",
			"transactionId",
			"transaction_id",
		]) {
			expect(text).not.toContain(`${forbidden}=`);
		}
	});

	test("TST-I-17 instances do not share state (own registry, not the global one)", async () => {
		const a = new PromMetrics();
		const b = new PromMetrics();
		a.retry("consumer");
		expect(
			sample(await a.render(), 'retries_total{component="consumer"}'),
		).toBe(1);
		expect(
			sample(await b.render(), 'retries_total{component="consumer"}'),
		).toBeUndefined();
	});

	test("TST-I-17 NoopMetrics accepts every call without effect", () => {
		const noop = new NoopMetrics();
		noop.transactionProcessed();
		noop.retry();
		noop.setCircuitBreakerOpen();
		expect(noop).toBeInstanceOf(NoopMetrics);
	});
});
