import type { Clock } from "../../../shared/clock";
import type { FaultInjector } from "../../../shared/fault-injector";
import type { IdGenerator } from "../../../shared/ids";
import { Money, type MoneyProps } from "../../../shared/money";
import type { OutboxRepository } from "../../messaging/application/outbox-repository";
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
	referenceBackoff: ReferenceBackoffConfig;
	/** `[0, 1)`; defaults to `Math.random`. Injectable for deterministic schedules. */
	random?: () => number;
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
			// Fast path (HTTP): a stored operation is answered without taking any lock.
			const stored = await this.deps.transactions.findByIdempotencyKey(
				command.providerId,
				command.idempotencyKey,
			);
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
			return this.resolveDuplicate(command, hash);
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

		// After every write, before the commit (N6).
		this.deps.faults.check("fail-mid-transaction");
		return toResult(transaction, false);
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
