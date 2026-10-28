import { Injectable } from "@nestjs/common";
import { RowNotFoundError } from "../../platform/application/persistence-errors";
import { MikroTransactionManager } from "../../platform/infrastructure/mikro-transaction-manager";
import { InboxRepository } from "../application/inbox-repository";
import type { InboxMessage } from "../domain/inbox-message";
import {
	inboxMessageToDomain,
	inboxMessageToRow,
} from "./inbox-message.mapper";
import { InboxMessageRow } from "./inbox-message.schema";

@Injectable()
export class MikroInboxRepository extends InboxRepository {
	constructor(private readonly tm: MikroTransactionManager) {
		super();
	}

	async tryReceive(message: InboxMessage): Promise<boolean> {
		const row = inboxMessageToRow(message);
		// Raw SQL: ON CONFLICT DO NOTHING on the (consumer_name, message_id) primary key.
		const rows = await this.tm.current().execute(
			`insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
			values (?, ?, ?, ?, ?)
			on conflict do nothing
			returning message_id`,
			[
				row.consumerName,
				row.messageId,
				row.payloadHash,
				row.receivedAt,
				row.processedAt,
			],
		);
		return rows.length === 1;
	}

	async find(
		consumerName: string,
		messageId: string,
	): Promise<InboxMessage | undefined> {
		const row = await this.tm
			.current()
			.findOne(
				InboxMessageRow,
				{ consumerName, messageId },
				{ disableIdentityMap: true },
			);
		return row === null ? undefined : inboxMessageToDomain(row);
	}

	async markProcessed(message: InboxMessage): Promise<void> {
		const rows = await this.tm
			.current()
			.execute(
				"update inbox_messages set processed_at = ? where consumer_name = ? and message_id = ? returning message_id",
				[message.processedAt ?? null, message.consumerName, message.messageId],
			);
		if (rows.length === 0) throw new RowNotFoundError("inbox message");
	}
}
