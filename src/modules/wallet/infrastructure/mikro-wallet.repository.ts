import { LockMode } from "@mikro-orm/core";
import { Injectable } from "@nestjs/common";
import { MikroTransactionManager } from "../../platform/infrastructure/mikro-transaction-manager";
import { WalletAlreadyExistsError } from "../application/errors";
import {
	VersionAssertionError,
	WalletRepository,
} from "../application/wallet-repository";
import type { Wallet } from "../domain/wallet";
import { walletToDomain, walletToRow } from "./wallet.mapper";
import { WalletRow } from "./wallet.schema";

const WALLET_PLAYER_CURRENCY_UK = "wallets_player_currency_uk";

function isUniqueViolation(error: unknown, constraint: string): boolean {
	let current: unknown = error;
	for (
		let depth = 0;
		depth < 5 && current !== undefined && current !== null;
		depth++
	) {
		const { code, constraint: name } = current as {
			code?: unknown;
			constraint?: unknown;
		};
		if (code === "23505" && name === constraint) return true;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

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
		try {
			await this.tm.current().insert(WalletRow, walletToRow(wallet));
		} catch (error) {
			// 23505 on the (player, currency) UNIQUE is the only source of truth for duplicates (RF-WAL-01).
			if (isUniqueViolation(error, WALLET_PLAYER_CURRENCY_UK)) {
				throw new WalletAlreadyExistsError();
			}
			throw error;
		}
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
