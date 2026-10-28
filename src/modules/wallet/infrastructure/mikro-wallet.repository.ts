import { LockMode } from "@mikro-orm/core";
import { Injectable } from "@nestjs/common";
import { MikroTransactionManager } from "../../platform/infrastructure/mikro-transaction-manager";
import {
	VersionAssertionError,
	WalletRepository,
} from "../application/wallet-repository";
import type { Wallet } from "../domain/wallet";
import { walletToDomain, walletToRow } from "./wallet.mapper";
import { WalletRow } from "./wallet.schema";

@Injectable()
export class MikroWalletRepository extends WalletRepository {
	constructor(private readonly tm: MikroTransactionManager) {
		super();
	}

	async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
		// `lockMode` makes MikroORM append FOR UPDATE; it needs the transaction, so refuse without one.
		const em = this.tm.requireTransaction("wallet FOR UPDATE");
		const row = await em.findOne(
			WalletRow,
			{ id },
			{ lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
		);
		return row === null ? undefined : walletToDomain(row);
	}

	async findById(id: string): Promise<Wallet | undefined> {
		const row = await this.tm
			.current()
			.findOne(WalletRow, { id }, { disableIdentityMap: true });
		return row === null ? undefined : walletToDomain(row);
	}

	async findByPlayerAndCurrency(
		playerId: string,
		currency: string,
	): Promise<Wallet | undefined> {
		const row = await this.tm
			.current()
			.findOne(WalletRow, { playerId, currency }, { disableIdentityMap: true });
		return row === null ? undefined : walletToDomain(row);
	}

	async insert(wallet: Wallet): Promise<void> {
		await this.tm.current().insert(WalletRow, walletToRow(wallet));
	}

	async updateBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
		// The version guard is the defence of ADR-0006: zero rows means a bug, and it is never retried.
		const rows = await this.tm
			.current()
			.execute(
				"update wallets set balance = ?, version = ?, updated_at = ? where id = ? and version = ? returning id",
				[
					wallet.balance.toString(),
					wallet.version,
					wallet.updatedAt,
					wallet.id,
					expectedVersion,
				],
			);
		if (rows.length === 0) {
			throw new VersionAssertionError(wallet.id, expectedVersion);
		}
	}
}
