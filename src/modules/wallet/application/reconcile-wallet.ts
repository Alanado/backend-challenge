import type { MoneyProps } from "../../../shared/money";
import type { AppLogger } from "../../platform/application/log-fields";
import type { MetricsPort } from "../../platform/application/metrics";
import { WalletNotFoundError } from "./errors";
import type { LedgerIntegrityRead } from "./ledger-integrity";

/** 04-api §5. */
export interface ReconciliationView {
	walletId: string;
	storedBalance: MoneyProps;
	calculatedBalance: MoneyProps;
	/** stored − calculated; negative when the ledger sums to more than the stored balance. */
	difference: MoneyProps;
	consistent: boolean;
	checkedEntries: number;
	chain: { continuous: boolean; firstBreakAtVersion: number | null };
}

/**
 * RF-REC-*: verifies `balance = Σ ledger` and the chain of one wallet, on the same reader as
 * `assertLedgerInvariant` (T-025b). One snapshot, no locks (ADR-0016). It reports and counts a
 * divergence; it never corrects one.
 */
export class ReconcileWallet {
	constructor(
		private readonly reader: LedgerIntegrityRead,
		private readonly metrics: MetricsPort,
		private readonly logger: AppLogger,
	) {}

	async execute(walletId: string): Promise<ReconciliationView> {
		const report = await this.reader.read(walletId);
		if (report === undefined) throw new WalletNotFoundError();

		if (!report.consistent) {
			this.metrics.reconciliationDivergence();
			const balanceMismatch = !report.difference.isZero();
			const chainBroken = !report.chain.continuous;
			// Codes and a version number only: no balance, difference or entry reaches the log.
			this.logger.error("reconciliation divergence detected", {
				walletId,
				reason:
					balanceMismatch && chainBroken
						? "balance_mismatch_and_chain_broken"
						: balanceMismatch
							? "balance_mismatch"
							: "chain_broken",
				...(report.chain.firstBreakAtVersion === null
					? {}
					: { firstBreakAtVersion: report.chain.firstBreakAtVersion }),
			});
		}

		return {
			walletId: report.walletId,
			storedBalance: report.storedBalance.toJSON(),
			calculatedBalance: report.calculatedBalance.toJSON(),
			difference: report.difference.toJSON(),
			consistent: report.consistent,
			checkedEntries: report.checkedEntries,
			chain: report.chain,
		};
	}
}
