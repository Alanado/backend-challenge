import { Injectable } from "@nestjs/common";
import { MikroTransactionManager } from "../../platform/infrastructure/mikro-transaction-manager";
import { LedgerRepository } from "../application/ledger-repository";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { ledgerEntryToDomain, ledgerEntryToRow } from "./ledger-entry.mapper";
import { LedgerEntryRow } from "./ledger-entry.schema";

@Injectable()
export class MikroLedgerRepository extends LedgerRepository {
	constructor(private readonly tm: MikroTransactionManager) {
		super();
	}

	async append(entry: WalletLedgerEntry): Promise<void> {
		await this.tm.current().insert(LedgerEntryRow, ledgerEntryToRow(entry));
	}

	async findByWallet(walletId: string): Promise<WalletLedgerEntry[]> {
		const rows = await this.tm
			.current()
			.find(
				LedgerEntryRow,
				{ walletId },
				{ orderBy: { walletVersion: "asc" }, disableIdentityMap: true },
			);
		return rows.map(ledgerEntryToDomain);
	}

	async findPage(
		walletId: string,
		page: { before?: number | undefined; limit: number },
	): Promise<WalletLedgerEntry[]> {
		const rows = await this.tm.current().find(
			LedgerEntryRow,
			{
				walletId,
				...(page.before === undefined
					? {}
					: { walletVersion: { $lt: page.before } }),
			},
			{
				orderBy: { walletVersion: "desc" },
				limit: page.limit,
				disableIdentityMap: true,
			},
		);
		return rows.map(ledgerEntryToDomain);
	}
}
