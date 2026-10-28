import type { Money } from "../../../shared/money";

export interface LedgerChainReport {
	continuous: boolean;
	/** `wallet_version` of the first entry (or the first missing one) that breaks the chain. */
	firstBreakAtVersion: number | null;
}

export interface LedgerIntegrityReport {
	walletId: string;
	storedBalance: Money;
	/** Σ CREDIT − Σ DEBIT over the whole ledger, independent of the stored balance. */
	calculatedBalance: Money;
	/** storedBalance − calculatedBalance. */
	difference: Money;
	checkedEntries: number;
	chain: LedgerChainReport;
	/** Stored balance equals the sum AND the chain is intact (ADR-0016). */
	consistent: boolean;
	/** Supporting data for `assertLedgerInvariant`. */
	walletVersion: number;
	lastLedgerVersion: number | null;
}

/** Port: one consistent snapshot, no locks (ADR-0016). `undefined` when the wallet does not exist. */
export abstract class LedgerIntegrityRead {
	abstract read(walletId: string): Promise<LedgerIntegrityReport | undefined>;
}
