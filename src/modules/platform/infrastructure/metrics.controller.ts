import { Controller, Get, Header } from "@nestjs/common";
import { Registry } from "prom-client";
import { PromMetrics } from "./prom-metrics";

/** `GET /metrics`: open by design (ADR-0017, 04-api). */
@Controller("metrics")
export class MetricsController {
	constructor(private readonly metrics: PromMetrics) {}

	// Method decorators only: the lint config does not allow parameter decorators.
	@Get()
	@Header("Content-Type", Registry.PROMETHEUS_CONTENT_TYPE)
	@Header("Cache-Control", "no-store")
	scrape(): Promise<string> {
		return this.metrics.render();
	}
}
