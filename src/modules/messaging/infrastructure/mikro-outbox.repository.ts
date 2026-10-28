import { LockMode } from "@mikro-orm/core";
import { Injectable } from "@nestjs/common";
import { MikroTransactionManager } from "../../platform/infrastructure/mikro-transaction-manager";
import { OutboxRepository } from "../application/outbox-repository";
import type { OutboxMessage } from "../domain/outbox-message";
import {
	outboxMessageToDomain,
	outboxMessageToRow,
} from "./outbox-message.mapper";
import { OutboxMessageRow } from "./outbox-message.schema";

@Injectable()
export class MikroOutboxRepository extends OutboxRepository {
	constructor(private readonly tm: MikroTransactionManager) {
		super();
	}

	async enqueue(message: OutboxMessage): Promise<void> {
		await this.tm
			.current()
			.insert(OutboxMessageRow, outboxMessageToRow(message));
	}

	async findById(id: string): Promise<OutboxMessage | undefined> {
		const row = await this.tm
			.current()
			.findOne(OutboxMessageRow, { id }, { disableIdentityMap: true });
		return row === null ? undefined : outboxMessageToDomain(row);
	}

	async lockPublishable(limit: number, now: Date): Promise<OutboxMessage[]> {
		const em = this.tm.requireTransaction("outbox FOR UPDATE SKIP LOCKED");
		const rows = await em.find(
			OutboxMessageRow,
			{ publishedAt: null, failedAt: null, nextAttemptAt: { $lte: now } },
			{
				orderBy: { occurredAt: "asc" },
				limit,
				lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
				disableIdentityMap: true,
			},
		);
		return rows.map(outboxMessageToDomain);
	}

	async update(message: OutboxMessage): Promise<void> {
		await this.tm.current().execute(
			`update outbox_messages set
				attempts = ?, next_attempt_at = ?, published_at = ?, failed_at = ?, last_error = ?
			where id = ?`,
			[
				message.attempts,
				message.nextAttemptAt,
				message.publishedAt ?? null,
				message.failedAt ?? null,
				message.lastError ?? null,
				message.id,
			],
		);
	}

	async oldestPendingOccurredAt(): Promise<Date | undefined> {
		const rows = await this.tm.current().execute(
			`select min(occurred_at) as oldest from outbox_messages
			where published_at is null and failed_at is null`,
		);
		const oldest = (rows[0] as { oldest: Date | null } | undefined)?.oldest;
		return oldest === null || oldest === undefined
			? undefined
			: new Date(oldest);
	}
}
