import type { Clock } from "../../../shared/clock";
import type { IdGenerator } from "../../../shared/ids";
import type { OutboxRepository } from "../../messaging/application/outbox-repository";
import type { AppLogger } from "../../platform/application/log-fields";
import type { MetricsPort } from "../../platform/application/metrics";
import type { TransactionManager } from "../../platform/application/transaction-manager";
import { WalletNotFoundError } from "../../wallet/application/errors";
import type { LedgerRepository } from "../../wallet/application/ledger-repository";
import type { WalletRepository } from "../../wallet/application/wallet-repository";
import type { ReferenceBackoffConfig } from "../domain/reference-backoff";
import { decideTransaction } from "../domain/transaction-policy";
import { WagerTransactionStatus } from "../domain/wager-transaction-status";
import { TransactionConclusion } from "./transaction-conclusion";
import type {
	PendingCandidate,
	WagerTransactionRepository,
} from "./wager-transaction-repository";

export const DEFAULT_CANDIDATE_LIMIT = 50;

export interface PendingReferenceWorkerDeps {
	tm: TransactionManager;
	wallets: WalletRepository;
	transactions: WagerTransactionRepository;
	ledger: LedgerRepository;
	outbox: OutboxRepository;
	clock: Clock;
	ids: IdGenerator;
	metrics: MetricsPort;
	logger: AppLogger;
	referenceBackoff: ReferenceBackoffConfig;
	/** Candidates of different wallets processed in parallel (`PENDING_REF_CONCURRENCY`). */
	concurrency: number;
	/** Candidates read per pass. */
	candidateLimit?: number;
	random?: () => number;
}

export interface PendingPassResult {
	candidates: number;
	processed: number;
	rejected: number;
	rescheduled: number;
	/** Lost the race: no longer pending, or no longer due once the wallet lock was held. */
	skipped: number;
	errors: number;
}

type Outcome = "processed" | "rejected" | "rescheduled" | "skipped";

/**
 * Retries the PENDING_REFERENCE transactions that are due (03-messaging §4, ADR-0013).
 *
 * Lock order (ADR-0007): the candidates are read WITHOUT a lock; each one then gets its own
 * transaction that takes the wallet `FOR UPDATE` first and the transaction row second, and
 * revalidates the row under both locks. The row is deliberately not claimed through a skip-locked
 * read: that would take the row before the wallet and open a cycle with the normal flow, which holds the
 * wallet and then updates pending rows (waking dependents). The revalidation is what makes
 * several workers safe: the loser finds the row concluded or rescheduled and does nothing.
 */
export class PendingReferenceWorker {
	private readonly conclusion: TransactionConclusion;
	private stopping = false;

	constructor(private readonly deps: PendingReferenceWorkerDeps) {
		this.conclusion = new TransactionConclusion(deps);
	}

	async runOnce(): Promise<PendingPassResult> {
		const { transactions, clock } = this.deps;
		const result: PendingPassResult = {
			candidates: 0,
			processed: 0,
			rejected: 0,
			rescheduled: 0,
			skipped: 0,
			errors: 0,
		};
		if (this.stopping) return result;
		const candidates = await transactions.findDuePendingReferences(
			clock.now(),
			this.deps.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT,
		);
		result.candidates = candidates.length;

		// Same wallet: in series (they would only queue on its lock). Distinct wallets: in parallel.
		const byWallet = new Map<string, PendingCandidate[]>();
		for (const candidate of candidates) {
			byWallet.set(candidate.walletId, [
				...(byWallet.get(candidate.walletId) ?? []),
				candidate,
			]);
		}
		const lanes = [...byWallet.values()];
		const workers = Array.from(
			{ length: Math.min(this.deps.concurrency, lanes.length) },
			async () => {
				for (
					let lane = lanes.shift();
					lane !== undefined;
					lane = lanes.shift()
				) {
					for (const candidate of lane) {
						if (this.stopping) return;
						await this.attempt(candidate, result);
					}
				}
			},
		);
		await Promise.all(workers);
		return result;
	}

	/** Lets the pass in progress finish its current transaction and take no further candidate. */
	stop(): void {
		this.stopping = true;
	}

	private async attempt(
		candidate: PendingCandidate,
		result: PendingPassResult,
	): Promise<void> {
		try {
			const outcome = await this.deps.tm.run(() => this.process(candidate));
			result[outcome] += 1;
			// After the commit: a rolled-back attempt did not happen.
			if (outcome === "rescheduled")
				this.deps.metrics.retry("pending_reference");
		} catch (error) {
			result.errors += 1;
			this.deps.logger.error(
				"pending reference attempt failed",
				{ transactionId: candidate.id, walletId: candidate.walletId },
				error,
			);
		}
	}

	private async process(candidate: PendingCandidate): Promise<Outcome> {
		const { wallets, transactions, clock } = this.deps;

		// (2) the wallet lock, before any wager_transactions row of this attempt is locked.
		const wallet = await wallets.findByIdForUpdate(candidate.walletId);
		if (wallet === undefined) throw new WalletNotFoundError();
		// (3) the row, then revalidation: another worker may have concluded or rescheduled it
		// while this one waited for the wallet.
		const transaction = await transactions.findByIdForUpdate(candidate.id);
		const now = clock.now();
		if (
			transaction === undefined ||
			transaction.status !== WagerTransactionStatus.PendingReference ||
			transaction.nextAttemptAt === undefined ||
			transaction.nextAttemptAt.getTime() > now.getTime()
		) {
			return "skipped";
		}

		const reference = await this.conclusion.resolveReference(transaction);
		const decision = decideTransaction({ wallet, transaction, reference });
		await this.conclusion.conclude(
			decision,
			wallet,
			transaction,
			reference,
			// No request or message started this attempt: a fresh id correlates its events.
			this.deps.ids.next(),
			now,
		);

		this.deps.logger.info("pending reference attempt concluded", {
			transactionId: transaction.id,
			walletId: wallet.id,
			providerId: transaction.providerId,
			kind: transaction.kind,
			status: transaction.status,
			...(transaction.failureCode === undefined
				? {}
				: { failureCode: transaction.failureCode }),
		});
		return outcomeOf(transaction.status);
	}
}

/** `conclude` moved the transaction out of PENDING_REFERENCE (or counted an attempt and kept it there). */
function outcomeOf(status: WagerTransactionStatus): Outcome {
	switch (status) {
		case WagerTransactionStatus.Processed:
			return "processed";
		case WagerTransactionStatus.Rejected:
			return "rejected";
		default:
			return "rescheduled";
	}
}
