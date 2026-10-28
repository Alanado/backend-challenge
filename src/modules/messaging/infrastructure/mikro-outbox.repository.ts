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
}
