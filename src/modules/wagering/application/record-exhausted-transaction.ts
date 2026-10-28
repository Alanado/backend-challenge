import type { Clock } from "../../../shared/clock";
import type { IdGenerator } from "../../../shared/ids";
import { Money } from "../../../shared/money";
import type { InboxRepository } from "../../messaging/application/inbox-repository";
import type { OutboxRepository } from "../../messaging/application/outbox-repository";
import { WagerTransactionFailed } from "../../messaging/domain/events/wager-transaction-failed";
import { InboxMessage } from "../../messaging/domain/inbox-message";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import type { MetricsPort } from "../../platform/application/metrics";
import type { TransactionManager } from "../../platform/application/transaction-manager";
import { WalletNotFoundError } from "../../wallet/application/errors";
import type { WalletRepository } from "../../wallet/application/wallet-repository";
import { FailureCode } from "../domain/failure-code";
import { WagerTransaction } from "../domain/wager-transaction";
import { InboxPayloadMismatchError } from "./errors";
import {
	commandPayloadHash,
	type SubmitWagerTransactionCommand,
	WAGER_CONSUMER_NAME,
} from "./submit-wager-transaction";
import type { WagerTransactionRepository } from "./wager-transaction-repository";

export interface RecordExhaustedTransactionDeps {
	tm: TransactionManager;
	wallets: WalletRepository;
	transactions: WagerTransactionRepository;
	outbox: OutboxRepository;
	inbox: InboxRepository;
	clock: Clock;
	ids: IdGenerator;
	metrics: MetricsPort;
}

export interface ExhaustedMessage {
	messageId: string;
	messageHash: string;
}

/**
 * `recorded`: the transaction is now FAILED and its event is in the outbox.
 * `already-handled`: it already has a result (an earlier attempt succeeded, or the message was
 * already processed); there is nothing to record and nothing to dead-letter.
 */
export type ExhaustionResult = "recorded" | "already-handled";

/**
 * The consumer gave up on a message (`ApproximateReceiveCount >= SQS_MAX_RECEIVE`): record the
 * transaction as FAILED / PROCESSING_ATTEMPTS_EXHAUSTED (03-messaging §3.3). Its own transaction,
 * in the canonical order: inbox, wallet `FOR UPDATE`, only then `wager_transactions`. It needs
 * the wallet lock like any decision does, so it cannot succeed while that lock stays held: the
 * caller treats a throw as "the database did not answer" and dead-letters anyway.
 */
export class RecordExhaustedTransaction {
	constructor(private readonly deps: RecordExhaustedTransactionDeps) {}

	execute(
		command: SubmitWagerTransactionCommand,
		message: ExhaustedMessage,
	): Promise<ExhaustionResult> {
		const { tm, wallets, transactions, outbox, inbox, clock, ids } = this.deps;
		return tm.run(async () => {
			const now = clock.now();

			const inboxMessage = InboxMessage.receive({
				messageId: message.messageId,
				consumerName: WAGER_CONSUMER_NAME,
				payloadHash: message.messageHash,
				now,
			});
			if (!(await inbox.tryReceive(inboxMessage))) {
				const existing = await inbox.find(
					WAGER_CONSUMER_NAME,
					message.messageId,
				);
				if (existing?.payloadHash !== message.messageHash) {
					throw new InboxPayloadMismatchError();
				}
				return "already-handled";
			}

			const wallet = await wallets.findByIdForUpdate(command.walletId);
			if (wallet === undefined) throw new WalletNotFoundError();

			const transaction = WagerTransaction.create({
				id: ids.next(),
				providerId: command.providerId,
				externalTransactionId: command.externalTransactionId,
				idempotencyKey: command.idempotencyKey,
				payloadHash: commandPayloadHash(command),
				walletId: command.walletId,
				playerId: command.playerId,
				roundId: command.roundId,
				gameId: command.gameId,
				kind: command.kind,
				money: Money.from(command.money),
				referenceExternalTransactionId: command.referenceExternalTransactionId,
				now,
			});
			let result: ExhaustionResult = "already-handled";
			if (await transactions.insertIfAbsent(transaction)) {
				transaction.fail(FailureCode.ProcessingAttemptsExhausted);
				await transactions.update(transaction, now);
				await outbox.enqueue(
					OutboxMessage.enqueue(
						WagerTransactionFailed.from(transaction, {
							eventId: ids.next(),
							correlationId: message.messageId,
							occurredAt: now,
						}),
						wallet.id,
					),
				);
				this.deps.metrics.transactionProcessed({
					status: transaction.status,
					kind: command.kind,
					channel: "sqs",
					failureCode: FailureCode.ProcessingAttemptsExhausted,
				});
				result = "recorded";
			}
			inboxMessage.markProcessed(now);
			await inbox.markProcessed(inboxMessage);
			return result;
		});
	}
}
