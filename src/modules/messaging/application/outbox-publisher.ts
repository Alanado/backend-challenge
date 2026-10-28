import type { Clock } from "../../../shared/clock";
import type { FaultInjector } from "../../../shared/fault-injector";
import type { AppLogger } from "../../platform/application/log-fields";
import type { MetricsPort } from "../../platform/application/metrics";
import type { TransactionManager } from "../../platform/application/transaction-manager";
import type { BackoffPolicy } from "../domain/outbox-message";
import type { MessagePublisher } from "./message-publisher";
import type { OutboxRepository } from "./outbox-repository";

export interface OutboxPublisherDeps {
	tm: TransactionManager;
	outbox: OutboxRepository;
	publisher: MessagePublisher;
	clock: Clock;
	metrics: MetricsPort;
	logger: AppLogger;
	faults: FaultInjector;
	batchSize: number;
	backoff: BackoffPolicy;
}

export interface PublishCycleResult {
	claimed: number;
	published: number;
	retried: number;
	failed: number;
}

/**
 * One publisher cycle (03-messaging §6.2, ADR-0014 option A): in a single transaction, claim a
 * batch with `FOR UPDATE SKIP LOCKED`, send it, mark each row by its own outcome, commit. The
 * rows it can see are only committed ones, so nothing is published before its effect commits;
 * a crash before the commit releases the locks and another publisher resends the same eventId.
 */
export class OutboxPublisher {
	constructor(private readonly deps: OutboxPublisherDeps) {}

	async publishOnce(): Promise<PublishCycleResult> {
		const { tm, outbox, publisher, clock, faults, logger } = this.deps;
		const result = await tm.run(async (): Promise<PublishCycleResult> => {
			const now = clock.now();
			const batch = await outbox.lockPublishable(this.deps.batchSize, now);
			if (batch.length === 0) {
				return { claimed: 0, published: 0, retried: 0, failed: 0 };
			}
			const outcomes = await publisher.publishBatch(
				batch.map((message) => ({
					id: message.id,
					groupKey: message.groupKey,
					body: JSON.stringify(message.payload),
				})),
			);
			// Between the send and the commit (N6): a crash here republishes the same eventId.
			faults.check("crash-after-publish-before-commit");

			const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
			const counts = {
				claimed: batch.length,
				published: 0,
				retried: 0,
				failed: 0,
			};
			for (const message of batch) {
				const outcome = byId.get(message.id);
				if (outcome?.status === "published") {
					message.markPublished(now);
					counts.published += 1;
				} else if (outcome?.status === "permanent") {
					message.markFailed(now, outcome.error);
					counts.failed += 1;
					logger.error("outbox event failed permanently", {
						eventId: message.id,
						errorCode: outcome.error,
					});
				} else {
					message.scheduleRetry(now, this.deps.backoff);
					counts.retried += 1;
				}
				await outbox.update(message);
			}
			return counts;
		});

		// Metrics only after the commit: a rolled-back cycle changed nothing.
		for (let i = 0; i < result.retried; i++) this.deps.metrics.retry("outbox");
		for (let i = 0; i < result.failed; i++)
			this.deps.metrics.outboxPublishFailed();
		await this.updateLag();
		return result;
	}

	private async updateLag(): Promise<void> {
		const oldest = await this.deps.outbox.oldestPendingOccurredAt();
		const lagMs =
			oldest === undefined
				? 0
				: this.deps.clock.now().getTime() - oldest.getTime();
		this.deps.metrics.setOutboxLagSeconds(Math.max(0, lagMs / 1000));
	}
}
