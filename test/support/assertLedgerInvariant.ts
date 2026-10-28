import type { LedgerIntegrityRead } from "../../src/modules/wallet/application/ledger-integrity";

/**
 * The ledger invariant of ADR-0016/ADR-0019: balance = Σ ledger, unbroken chain, balance >= 0 and a
 * coherent `version`. T-035 reuses this very function behind the reconciliation route.
 * Throws with every violated rule listed.
 */
export async function assertLedgerInvariant(
	reader: LedgerIntegrityRead,
	walletId: string,
): Promise<void> {
	const report = await reader.read(walletId);
	if (report === undefined) {
		throw new Error(`ledger invariant: wallet ${walletId} does not exist`);
	}
	const problems: string[] = [];
	if (!report.difference.isZero()) {
		problems.push(
			`stored balance ${report.storedBalance} != ledger sum ${report.calculatedBalance} (difference ${report.difference})`,
		);
	}
	if (!report.chain.continuous) {
		problems.push(
			`chain broken at wallet_version ${report.chain.firstBreakAtVersion}`,
		);
	}
	if (report.storedBalance.isNegative()) {
		problems.push(`stored balance ${report.storedBalance} is negative`);
	}
	// A wallet with no entries is at version 1; otherwise its version is the last entry's.
	const expectedVersion = report.lastLedgerVersion ?? 1;
	if (report.walletVersion !== expectedVersion) {
		problems.push(
			`wallets.version ${report.walletVersion} != last ledger version ${expectedVersion}`,
		);
	}
	if (!report.consistent && problems.length === 0) {
		problems.push("reader reported consistent=false without a specific cause");
	}
	if (problems.length > 0) {
		throw new Error(
			`ledger invariant violated for wallet ${walletId} (${report.checkedEntries} entries): ${problems.join("; ")}`,
		);
	}
}

/** For `afterAll`: every wallet the test created through the builders must still satisfy the invariant. */
export async function assertCreatedWalletsConsistent(
	reader: LedgerIntegrityRead,
	walletIds: readonly string[],
): Promise<void> {
	for (const id of walletIds) await assertLedgerInvariant(reader, id);
}
