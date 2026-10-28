import type { Clock } from "../../../shared/clock";
import type { FaultInjector } from "../../../shared/fault-injector";
import type { IdGenerator } from "../../../shared/ids";
import { Money, type MoneyProps } from "../../../shared/money";
import type { InboxRepository } from "../../messaging/application/inbox-repository";
import type { OutboxRepository } from "../../messaging/application/outbox-repository";
import { InboxMessage } from "../../messaging/domain/inbox-message";
import { LogContext } from "../../platform/application/log-context";
import type { AppLogger } from "../../platform/application/log-fields";
import type { MetricsPort } from "../../platform/application/metrics";
import { TransientPersistenceError } from "../../platform/application/persistence-errors";
import type { TransactionManager } from "../../platform/application/transaction-manager";
import { RequestValidationError } from "../../platform/application/validation-error";
import { WalletNotFoundError } from "../../wallet/application/errors";
import type { LedgerRepository } from "../../wallet/application/ledger-repository";
import {
	VersionAssertionError,
	type WalletRepository,
} from "../../wallet/application/wallet-repository";
import type { FailureCode } from "../domain/failure-code";
import { payloadHash } from "../domain/payload-hash";
import { type ReferenceBackoffConfig } from "../domain/reference-backoff";
import { decideTransaction } from "../domain/transaction-policy";
import { WagerTransaction } from "../domain/wager-transaction";
import { WagerTransactionKind } from "../domain/wager-transaction-kind";
import { WagerTransactionStatus } from "../domain/wager-transaction-status";
import {
	ExternalTransactionIdConflictError,
	IdempotencyKeyPayloadMismatchError,
	InboxPayloadMismatchError,
} from "./errors";
import { TransactionConclusion } from "./transaction-conclusion";
import type { WagerTransactionRepository } from "./wager-transaction-repository";

export interface SubmitWagerTransactionCommand {
	providerId: string;
	externalTransactionId: string;
	idempotencyKey: string;
	playerId: string;
	walletId: string;
	roundId: string;
	gameId: string;
	kind: WagerTransactionKind;
	money: MoneyProps;
	referenceExternalTransactionId?: string | undefined;
}

/** The inbox consumer name of 02-design §4: part of the inbox primary key. */
export const WAGER_CONSUMER_NAME = "wager-transactions-consumer";

/**
 * Where the submission came from. SQS adds what the inbox needs: the message's own id and the
 * hash of its whole body; its `correlationId` is the `messageId` (03-messaging §7).
 */
export type SubmissionContext =
	| { channel: "http"; correlationId: string }
	| {
			channel: "sqs";
			correlationId: string;
			messageId: string;
			messageHash: string;
	  };

/** 04-api §2 "Resultado de transação". */
export interface WagerTransactionResult {
	transactionId: string;
	status: WagerTransactionStatus;
	/** `observed_balance`; null only for FAILED. */
	balance: MoneyProps | null;
	failureCode: FailureCode | null;
	idempotentReplay: boolean;
}

export interface SubmitWagerTransactionDeps {
	tm: TransactionManager;
	wallets: WalletRepository;
	transactions: WagerTransactionRepository;
	ledger: LedgerRepository;
	outbox: OutboxRepository;
	inbox: InboxRepository;
	clock: Clock;
	ids: IdGenerator;
	metrics: MetricsPort;
	logger: AppLogger;
	faults: FaultInjector;
	referenceBackoff: ReferenceBackoffConfig;
	/** `[0, 1)`; defaults to `Math.random`. Injectable for deterministic schedules. */
	random?: () => number;
}

/** The business hash of a command (04-api §6): what makes "the same key, another payload" detectable. */
export function commandPayloadHash(
	command: SubmitWagerTransactionCommand,
): string {
	return payloadHash({
		providerId: command.providerId,
		externalTransactionId: command.externalTransactionId,
		playerId: command.playerId,
		walletId: command.walletId,
		roundId: command.roundId,
		gameId: command.gameId,
		kind: command.kind,
		money: Money.from(command.money),
		referenceExternalTransactionId: command.referenceExternalTransactionId,
	});
}

export function toResult(
	transaction: WagerTransaction,
	idempotentReplay: boolean,
): WagerTransactionResult {
	return {
		transactionId: transaction.id,
		status: transaction.status,
		balance: transaction.observedBalance?.toJSON() ?? null,
		failureCode: transaction.failureCode ?? null,
		idempotentReplay,
	};
}

/**
 * The financial pipeline of 02-design §5, for both channels.
 *
 * Lock order (ADR-0007): (1) the inbox row (SQS only), (2) the wallet `FOR UPDATE`, (3) rows of
 * `wager_transactions`. Nothing in this class writes `wager_transactions` before the wallet is
 * locked, and nothing touches the inbox after it.
 */
export class SubmitWagerTransaction {
	private readonly conclusion: TransactionConclusion;

	constructor(private readonly deps: SubmitWagerTransactionDeps) {
		this.conclusion = new TransactionConclusion(deps);
	}

	async execute(
		command: SubmitWagerTransactionCommand,
		context: SubmissionContext,
	): Promise<WagerTransactionResult> {
		const startedAt = performance.now();
		if (command.kind === WagerTransactionKind.Opening) {
			throw new RequestValidationError([
				{ path: "kind", message: "OPENING cannot be submitted" },
			]);
		}
		LogContext.set({
			providerId: command.providerId,
			walletId: command.walletId,
		});
		// Before any database access (02-design §5).
		const hash = commandPayloadHash(command);

		let result: WagerTransactionResult;
		try {
			// Fast path (HTTP only): a stored operation is answered without taking any lock. The SQS
			// channel goes straight to the transaction: its inbox is what deduplicates.
			const stored =
				context.channel === "http"
					? await this.deps.transactions.findByIdempotencyKey(
							command.providerId,
							command.idempotencyKey,
						)
					: undefined;
			result =
				stored !== undefined
					? this.replayOrConflict(stored, hash)
					: await this.deps.tm.run(() =>
							this.processInTransaction(command, context, hash),
						);
		} catch (error) {
			this.countFailure(error, context);
			throw error;
		}

		const durationMs = performance.now() - startedAt;
		if (result.idempotentReplay) {
			this.deps.metrics.idempotentRequest("replay", context.channel);
		} else {
			this.deps.metrics.transactionProcessed({
				status: result.status,
				kind: command.kind,
				channel: context.channel,
				failureCode: result.failureCode ?? undefined,
			});
		}
		this.deps.metrics.observeProcessingDuration(durationMs / 1000, {
			channel: context.channel,
			kind: command.kind,
			outcome: result.idempotentReplay ? "replay" : result.status,
		});
		this.deps.logger.info(
			result.idempotentReplay
				? "wager transaction replayed"
				: "wager transaction concluded",
			{
				transactionId: result.transactionId,
				walletId: command.walletId,
				providerId: command.providerId,
				kind: command.kind,
				status: result.status,
				...(result.failureCode === null
					? {}
					: { failureCode: result.failureCode }),
				channel: context.channel,
				durationMs: Math.round(durationMs),
			},
		);
		return result;
	}

	private async processInTransaction(
		command: SubmitWagerTransactionCommand,
		context: SubmissionContext,
		hash: string,
	): Promise<WagerTransactionResult> {
		const { wallets, transactions } = this.deps;
		const now = this.deps.clock.now();

		// (1) the inbox, before the wallet lock (ADR-0007). A duplicate waits here for the first
		// delivery's commit while holding nothing but this transaction.
		let inboxMessage: InboxMessage | undefined;
		if (context.channel === "sqs") {
			inboxMessage = InboxMessage.receive({
				messageId: context.messageId,
				consumerName: WAGER_CONSUMER_NAME,
				payloadHash: context.messageHash,
				now,
			});
			if (!(await this.deps.inbox.tryReceive(inboxMessage))) {
				return this.resolveInboxDuplicate(command, context);
			}
		}

		// (2) the wallet lock, before any wager_transactions row is touched.
		const wallet = await wallets.findByIdForUpdate(command.walletId);
		if (wallet === undefined) throw new WalletNotFoundError();

		const transaction = WagerTransaction.create({
			id: this.deps.ids.next(),
			providerId: command.providerId,
			externalTransactionId: command.externalTransactionId,
			idempotencyKey: command.idempotencyKey,
			payloadHash: hash,
			walletId: command.walletId,
			playerId: command.playerId,
			roundId: command.roundId,
			gameId: command.gameId,
			kind: command.kind,
			money: Money.from(command.money),
			referenceExternalTransactionId: command.referenceExternalTransactionId,
			now,
		});
		LogContext.setTransactionId(transaction.id);

		// (3) INSERT … ON CONFLICT DO NOTHING without a conflict target.
		if (!(await transactions.insertIfAbsent(transaction))) {
			// A replay under another messageId is still a message handled: close its inbox row too.
			const replay = await this.resolveDuplicate(command, hash);
			await this.markInboxProcessed(inboxMessage, now);
			return replay;
		}

		const reference = await this.conclusion.resolveReference(transaction);
		const decision = decideTransaction({ wallet, transaction, reference });
		await this.conclusion.conclude(
			decision,
			wallet,
			transaction,
			reference,
			context.correlationId,
			now,
		);

		await this.markInboxProcessed(inboxMessage, now);

		// After every write, before the commit (N6).
		this.deps.faults.check("fail-mid-transaction");
		return toResult(transaction, false);
	}

	private async markInboxProcessed(
		inboxMessage: InboxMessage | undefined,
		now: Date,
	): Promise<void> {
		if (inboxMessage === undefined) return;
		inboxMessage.markProcessed(now);
		await this.deps.inbox.markProcessed(inboxMessage);
	}

	/**
	 * The inbox already holds this `messageId` (committed by an earlier delivery, which also
	 * committed its effect). Same body: a redelivery, answered as a replay of what was stored,
	 * with no new effect. Another body: not a redelivery.
	 */
	private async resolveInboxDuplicate(
		command: SubmitWagerTransactionCommand,
		context: Extract<SubmissionContext, { channel: "sqs" }>,
	): Promise<WagerTransactionResult> {
		const existing = await this.deps.inbox.find(
			WAGER_CONSUMER_NAME,
			context.messageId,
		);
		if (existing === undefined) {
			// A conflict on the primary key means a committed row; rows are never deleted.
			throw new Error("inbox insert conflicted but no row is visible");
		}
		if (existing.payloadHash !== context.messageHash) {
			throw new InboxPayloadMismatchError();
		}
		const stored = await this.deps.transactions.findByIdempotencyKey(
			command.providerId,
			command.idempotencyKey,
		);
		if (stored === undefined) {
			// Inbox row and transaction commit together; one without the other is a bug.
			throw new Error("inbox message without its transaction");
		}
		return toResult(stored, true);
	}

	/**
	 * The INSERT did nothing: someone committed the same key or external id after our fast path.
	 * Read again (a new statement sees the committed row under READ COMMITTED), with the wallet
	 * still locked, and classify.
	 */
	private async resolveDuplicate(
		command: SubmitWagerTransactionCommand,
		hash: string,
	): Promise<WagerTransactionResult> {
		const { transactions } = this.deps;
		const byKey = await transactions.findByIdempotencyKey(
			command.providerId,
			command.idempotencyKey,
		);
		if (byKey !== undefined) return this.replayOrConflict(byKey, hash);

		const byExternalId = await transactions.findByExternalId(
			command.providerId,
			command.externalTransactionId,
		);
		if (byExternalId !== undefined)
			throw new ExternalTransactionIdConflictError();

		// Both UNIQUEs and the PK are the only conflict sources, and rows are never deleted.
		throw new Error("insert conflicted but no conflicting row is visible");
	}

	/** Same key: the same payload is a replay of the stored (current) state; another payload is a 409. */
	private replayOrConflict(
		stored: WagerTransaction,
		hash: string,
	): WagerTransactionResult {
		if (!stored.matchesPayload(hash)) {
			throw new IdempotencyKeyPayloadMismatchError();
		}
		return toResult(stored, true);
	}

	private countFailure(error: unknown, context: SubmissionContext): void {
		if (
			error instanceof IdempotencyKeyPayloadMismatchError ||
			error instanceof ExternalTransactionIdConflictError
		) {
			this.deps.metrics.idempotentRequest("conflict", context.channel);
		} else if (error instanceof VersionAssertionError) {
			this.deps.metrics.lockConflict("version_assert");
		} else if (
			error instanceof TransientPersistenceError &&
			(error.kind === "lock_timeout" || error.kind === "deadlock")
		) {
			this.deps.metrics.lockConflict(error.kind);
		}
	}
}
