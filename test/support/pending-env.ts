import { PendingReferenceWorker } from "../../src/modules/wagering/application/pending-reference-worker";
import type { WagerTransactionRepository } from "../../src/modules/wagering/application/wager-transaction-repository";
import type { ReferenceBackoffConfig } from "../../src/modules/wagering/domain/reference-backoff";
import { Uuidv7Generator } from "../../src/shared/ids";
import type { Persistence } from "./persistence";
import {
	RecordingLogger,
	RecordingMetrics,
	type SteppingClock,
} from "./submit-harness";

/** Tests override the defaults of ADR-0013 with milliseconds. */
export const FAST_BACKOFF: ReferenceBackoffConfig = {
	maxAttempts: 3,
	baseMs: 100,
	factor: 2,
	capMs: 1000,
};

export interface WorkerRigOptions {
	clock: SteppingClock;
	backoff?: ReferenceBackoffConfig;
	concurrency?: number;
	/** Wraps the transaction repository, e.g. to hold the worker after it read its candidates. */
	wrapTransactions?: (
		real: WagerTransactionRepository,
	) => WagerTransactionRepository;
}

export function createWorkerRig(p: Persistence, options: WorkerRigOptions) {
	const metrics = new RecordingMetrics();
	const logger = new RecordingLogger();
	const worker = new PendingReferenceWorker({
		tm: p.tm,
		wallets: p.wallets,
		transactions: options.wrapTransactions?.(p.transactions) ?? p.transactions,
		ledger: p.ledger,
		outbox: p.outbox,
		clock: options.clock,
		ids: new Uuidv7Generator(),
		metrics,
		logger,
		referenceBackoff: options.backoff ?? FAST_BACKOFF,
		concurrency: options.concurrency ?? 5,
		random: () => 0.5,
	});
	return { worker, metrics, logger };
}
