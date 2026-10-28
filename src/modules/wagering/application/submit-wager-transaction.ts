import type { Clock } from "../../../shared/clock";
import type { FaultInjector } from "../../../shared/fault-injector";
import type { IdGenerator } from "../../../shared/ids";
import { Money, type MoneyProps } from "../../../shared/money";
import type { OutboxRepository } from "../../messaging/application/outbox-repository";
import { WagerTransactionProcessed } from "../../messaging/domain/events/wager-transaction-processed";
import { WagerTransactionRejected } from "../../messaging/domain/events/wager-transaction-rejected";
import { WalletBalanceChanged } from "../../messaging/domain/events/wallet-balance-changed";
import type { IntegrationEvent } from "../../messaging/domain/integration-event";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
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
import type { Wallet } from "../../wallet/domain/wallet";
import {
	LedgerDirection,
	type WalletLedgerEntry,
} from "../../wallet/domain/wallet-ledger-entry";
import type { FailureCode } from "../domain/failure-code";
import { payloadHash } from "../domain/payload-hash";
import {
	decideTransaction,
	type ReferenceFacts,
	type TransactionDecision,
} from "../domain/transaction-policy";
import { WagerTransaction } from "../domain/wager-transaction";
import { WagerTransactionKind } from "../domain/wager-transaction-kind";
import type { WagerTransactionStatus } from "../domain/wager-transaction-status";
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

/** T-042a widens `channel` with the SQS variant (`messageId`, inbox). */
export interface SubmissionContext {
	channel: "http";
	correlationId: string;
}

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
	clock: Clock;
	ids: IdGenerator;
	metrics: MetricsPort;
	logger: AppLogger;
	faults: FaultInjector;
}

/** Placeholder of T-031a: the duplicate handling (replay / 409) is T-031b. Never process a duplicate by mistake. */
export class DuplicateTransactionNotHandledYet extends Error {
	constructor() {
		super("the transaction already exists and duplicates are not handled yet");
		this.name = "DuplicateTransactionNotHandledYet";
	}
}

/** Placeholder of T-031a: reference resolution is T-032. A reference is never silently ignored. */
export class ReferenceResolutionNotImplementedYet extends Error {
	constructor() {
		super("reference resolution is not implemented yet");
		this.name = "ReferenceResolutionNotImplementedYet";
	}
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
 * The financial pipeline of 02-design §5 for the HTTP channel.
 *
 * Lock order (ADR-0007): wallet `FOR UPDATE` first, only then any row of `wager_transactions`.
 * Nothing in this class touches `wager_transactions` before `findByIdForUpdate` returns.
 */
export class SubmitWagerTransaction {
	constructor(private readonly deps: SubmitWagerTransactionDeps) {}

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
		const hash = payloadHash({
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

		let result: WagerTransactionResult;
		try {
			result = await this.deps.tm.run(() =>
				this.processInTransaction(command, context, hash),
			);
		} catch (error) {
			this.countLockConflict(error);
			throw error;
		}

		const durationMs = performance.now() - startedAt;
		this.deps.metrics.transactionProcessed({
			status: result.status,
			kind: command.kind,
			channel: context.channel,
			failureCode: result.failureCode ?? undefined,
		});
		this.deps.metrics.observeProcessingDuration(durationMs / 1000, {
			channel: context.channel,
			kind: command.kind,
			outcome: result.status,
		});
		this.deps.logger.info("wager transaction concluded", {
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
		});
		return result;
	}

	private async processInTransaction(
		command: SubmitWagerTransactionCommand,
		context: SubmissionContext,
		hash: string,
	): Promise<WagerTransactionResult> {
		const { wallets, transactions } = this.deps;

		// (2) the wallet lock, before any wager_transactions row is touched.
		const wallet = await wallets.findByIdForUpdate(command.walletId);
		if (wallet === undefined) throw new WalletNotFoundError();

		const now = this.deps.clock.now();
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
			throw new DuplicateTransactionNotHandledYet();
		}

		const reference = await this.resolveReference(transaction);
		const decision = decideTransaction({ wallet, transaction, reference });
		await this.conclude(decision, wallet, transaction, reference, context, now);

		// After every write, before the commit (N6).
		this.deps.faults.check("fail-mid-transaction");
		return toResult(transaction, false);
	}

	private async resolveReference(
		transaction: WagerTransaction,
	): Promise<ReferenceFacts | undefined> {
		if (transaction.referenceExternalTransactionId !== undefined) {
			throw new ReferenceResolutionNotImplementedYet();
		}
		return undefined;
	}

	private async conclude(
		decision: TransactionDecision,
		wallet: Wallet,
		transaction: WagerTransaction,
		reference: ReferenceFacts | undefined,
		context: SubmissionContext,
		now: Date,
	): Promise<void> {
		const { transactions, outbox } = this.deps;
		const events: IntegrationEvent<unknown>[] = [];
		const eventContext = () => ({
			eventId: this.deps.ids.next(),
			correlationId: context.correlationId,
			occurredAt: now,
		});

		switch (decision.type) {
			case "REJECT": {
				transaction.reject(decision.failureCode, wallet.balance);
				events.push(WagerTransactionRejected.from(transaction, eventContext()));
				break;
			}
			case "PENDING_REFERENCE": {
				throw new ReferenceResolutionNotImplementedYet();
			}
			case "APPLY": {
				const entry = await this.moveBalance(
					decision.direction,
					wallet,
					transaction,
					now,
				);
				transaction.markProcessed(
					reference?.transaction.id,
					now,
					wallet.balance,
				);
				events.push(
					WagerTransactionProcessed.from(transaction, eventContext()),
				);
				if (entry !== undefined) {
					events.push(WalletBalanceChanged.from(entry, eventContext()));
				}
				break;
			}
		}

		await transactions.update(transaction, now);
		for (const event of events) {
			await outbox.enqueue(OutboxMessage.enqueue(event, wallet.id));
		}
	}

	/** Debit/credit the locked wallet and append the ledger entry; `undefined` direction = LOSS (no movement). */
	private async moveBalance(
		direction: LedgerDirection | undefined,
		wallet: Wallet,
		transaction: WagerTransaction,
		now: Date,
	): Promise<WalletLedgerEntry | undefined> {
		if (direction === undefined) return undefined;
		const expectedVersion = wallet.version;
		const entryId = this.deps.ids.next();
		const entry =
			direction === LedgerDirection.Debit
				? wallet.debit(transaction.money, transaction.id, now, entryId)
				: wallet.credit(transaction.money, transaction.id, now, entryId);
		await this.deps.wallets.updateBalance(wallet, expectedVersion);
		await this.deps.ledger.append(entry);
		return entry;
	}

	private countLockConflict(error: unknown): void {
		if (error instanceof VersionAssertionError) {
			this.deps.metrics.lockConflict("version_assert");
		} else if (
			error instanceof TransientPersistenceError &&
			(error.kind === "lock_timeout" || error.kind === "deadlock")
		) {
			this.deps.metrics.lockConflict(error.kind);
		}
	}
}
