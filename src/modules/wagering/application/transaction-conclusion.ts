import type { IdGenerator } from "../../../shared/ids";
import type { OutboxRepository } from "../../messaging/application/outbox-repository";
import { WagerTransactionPendingReference } from "../../messaging/domain/events/wager-transaction-pending-reference";
import { WagerTransactionProcessed } from "../../messaging/domain/events/wager-transaction-processed";
import { WagerTransactionRejected } from "../../messaging/domain/events/wager-transaction-rejected";
import { WalletBalanceChanged } from "../../messaging/domain/events/wallet-balance-changed";
import type { IntegrationEvent } from "../../messaging/domain/integration-event";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import type { LedgerRepository } from "../../wallet/application/ledger-repository";
import type { WalletRepository } from "../../wallet/application/wallet-repository";
import type { Wallet } from "../../wallet/domain/wallet";
import {
	LedgerDirection,
	type WalletLedgerEntry,
} from "../../wallet/domain/wallet-ledger-entry";
import { FailureCode } from "../domain/failure-code";
import {
	type ReferenceBackoffConfig,
	referenceBackoff,
} from "../domain/reference-backoff";
import type {
	ReferenceFacts,
	TransactionDecision,
} from "../domain/transaction-policy";
import type { WagerTransaction } from "../domain/wager-transaction";
import { WagerTransactionStatus } from "../domain/wager-transaction-status";
import type { WagerTransactionRepository } from "./wager-transaction-repository";

export interface TransactionConclusionDeps {
	wallets: WalletRepository;
	transactions: WagerTransactionRepository;
	ledger: LedgerRepository;
	outbox: OutboxRepository;
	ids: IdGenerator;
	referenceBackoff: ReferenceBackoffConfig;
	/** `[0, 1)`; defaults to `Math.random`. Injectable for deterministic schedules. */
	random?: () => number;
}

/**
 * The "resolve the reference and apply the decision" half of the financial pipeline, shared by
 * `SubmitWagerTransaction` (a transaction's first pass) and the pending-reference worker (its
 * retries). Callers hold the wallet lock first (ADR-0007); nothing here takes a lock of its own.
 */
export class TransactionConclusion {
	constructor(private readonly deps: TransactionConclusionDeps) {}

	/**
	 * Looks the reference up by (provider, external id) with NO wallet filter (ADR-0013), after the
	 * wallet lock: reversals on this wallet are serialized, so "already reversed" cannot go stale.
	 */
	async resolveReference(
		transaction: WagerTransaction,
	): Promise<ReferenceFacts | undefined> {
		const externalId = transaction.referenceExternalTransactionId;
		if (externalId === undefined) return undefined;
		const { transactions } = this.deps;
		const referenced = await transactions.findByExternalId(
			transaction.providerId,
			externalId,
		);
		if (referenced === undefined) return undefined;
		// The partial unique index (ADR-0010) is the safety net behind this check.
		const alreadyReversed =
			referenced.status === WagerTransactionStatus.Processed &&
			(await transactions.existsProcessedReversalOf(referenced.id));
		return { transaction: referenced, alreadyReversed };
	}

	/**
	 * Applies `decision` to `transaction` and writes the result, the dependents' wake-up and the
	 * outbox events, all in the caller's transaction. A PENDING_REFERENCE decision on a transaction
	 * that is already PENDING_REFERENCE is a retry, not a transition: it counts the attempt,
	 * reschedules, emits no event, and past the attempt budget rejects with REFERENCE_NOT_FOUND.
	 */
	async conclude(
		decision: TransactionDecision,
		wallet: Wallet,
		transaction: WagerTransaction,
		reference: ReferenceFacts | undefined,
		correlationId: string,
		now: Date,
	): Promise<void> {
		const { transactions, outbox } = this.deps;
		const events: IntegrationEvent<unknown>[] = [];
		const eventContext = () => ({
			eventId: this.deps.ids.next(),
			correlationId,
			occurredAt: now,
		});

		switch (decision.type) {
			case "REJECT": {
				transaction.reject(decision.failureCode, wallet.balance);
				events.push(WagerTransactionRejected.from(transaction, eventContext()));
				break;
			}
			case "PENDING_REFERENCE": {
				if (transaction.status === WagerTransactionStatus.PendingReference) {
					this.retryPending(transaction, wallet, events, eventContext, now);
					break;
				}
				const delayMs = referenceBackoff(
					0,
					this.deps.referenceBackoff,
					this.deps.random,
				);
				transaction.markPendingReference(
					new Date(now.getTime() + delayMs),
					wallet.balance,
				);
				events.push(
					WagerTransactionPendingReference.from(transaction, eventContext()),
				);
				break;
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
		if (transaction.status === WagerTransactionStatus.Processed) {
			// Same transaction, restricted to the locked wallet (ADR-0007): the pending ones may retry now.
			await transactions.wakeDependents(
				transaction.providerId,
				transaction.externalTransactionId,
				wallet.id,
				now,
			);
		}
		for (const event of events) {
			await outbox.enqueue(OutboxMessage.enqueue(event, wallet.id));
		}
	}

	/**
	 * The reference is still missing (or itself still pending). The first entry into the state is
	 * not an attempt; each worker retry is. The retry number `n` that brings the count to
	 * `maxAttempts` is the last one: the transaction is rejected instead of rescheduled.
	 */
	private retryPending(
		transaction: WagerTransaction,
		wallet: Wallet,
		events: IntegrationEvent<unknown>[],
		eventContext: () => {
			eventId: string;
			correlationId: string;
			occurredAt: Date;
		},
		now: Date,
	): void {
		const attempts = transaction.referenceAttempts + 1;
		if (attempts >= this.deps.referenceBackoff.maxAttempts) {
			transaction.rescheduleReference(now); // counts the attempt; `reject` clears the schedule
			transaction.reject(FailureCode.ReferenceNotFound, wallet.balance);
			events.push(WagerTransactionRejected.from(transaction, eventContext()));
			return;
		}
		const delayMs = referenceBackoff(
			attempts,
			this.deps.referenceBackoff,
			this.deps.random,
		);
		transaction.rescheduleReference(new Date(now.getTime() + delayMs));
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
}
