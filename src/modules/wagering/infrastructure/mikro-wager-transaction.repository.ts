import { LockMode } from "@mikro-orm/core";
import { Injectable } from "@nestjs/common";
import { RowNotFoundError } from "../../platform/application/persistence-errors";
import { MikroTransactionManager } from "../../platform/infrastructure/mikro-transaction-manager";
import {
	type PendingCandidate,
	WagerTransactionRepository,
} from "../application/wager-transaction-repository";
import type { WagerTransaction } from "../domain/wager-transaction";
import {
	wagerTransactionToDomain,
	wagerTransactionToRow,
} from "./wager-transaction.mapper";
import { WagerTransactionRow } from "./wager-transaction.schema";

@Injectable()
export class MikroWagerTransactionRepository extends WagerTransactionRepository {
	constructor(private readonly tm: MikroTransactionManager) {
		super();
	}

	async insertIfAbsent(transaction: WagerTransaction): Promise<boolean> {
		const row = wagerTransactionToRow(transaction, transaction.createdAt);
		// Raw SQL: ON CONFLICT DO NOTHING with no conflict target covers both UNIQUEs at once (ADR-0007).
		const rows = await this.tm.current().execute(
			`insert into wager_transactions (
				id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
				round_id, game_id, kind, amount, currency, status, reference_external_transaction_id,
				reference_transaction_id, failure_code, observed_balance, reference_attempts, next_attempt_at,
				created_at, processed_at, updated_at
			) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			on conflict do nothing
			returning id`,
			[
				row.id,
				row.providerId,
				row.externalTransactionId,
				row.idempotencyKey,
				row.payloadHash,
				row.walletId,
				row.playerId,
				row.roundId,
				row.gameId,
				row.kind,
				row.amount,
				row.currency,
				row.status,
				row.referenceExternalTransactionId,
				row.referenceTransactionId,
				row.failureCode,
				row.observedBalance,
				row.referenceAttempts,
				row.nextAttemptAt,
				row.createdAt,
				row.processedAt,
				row.updatedAt,
			],
		);
		return rows.length === 1;
	}

	findById(id: string): Promise<WagerTransaction | undefined> {
		return this.findOneBy({ id });
	}

	findByIdempotencyKey(
		providerId: string,
		idempotencyKey: string,
	): Promise<WagerTransaction | undefined> {
		return this.findOneBy({ providerId, idempotencyKey });
	}

	findByExternalId(
		providerId: string,
		externalTransactionId: string,
	): Promise<WagerTransaction | undefined> {
		return this.findOneBy({ providerId, externalTransactionId });
	}

	async findByIdForUpdate(id: string): Promise<WagerTransaction | undefined> {
		const em = this.tm.requireTransaction("wager_transaction FOR UPDATE");
		const row = await em.findOne(
			WagerTransactionRow,
			{ id },
			{ lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
		);
		return row === null ? undefined : wagerTransactionToDomain(row);
	}

	async update(transaction: WagerTransaction, now: Date): Promise<void> {
		const row = wagerTransactionToRow(transaction, now);
		// Only the mutable columns; the guard trigger rejects any change to the identity ones.
		const rows = await this.tm.current().execute(
			`update wager_transactions set
				status = ?, reference_transaction_id = ?, failure_code = ?, observed_balance = ?,
				reference_attempts = ?, next_attempt_at = ?, processed_at = ?, updated_at = ?
			where id = ?
			returning id`,
			[
				row.status,
				row.referenceTransactionId,
				row.failureCode,
				row.observedBalance,
				row.referenceAttempts,
				row.nextAttemptAt,
				row.processedAt,
				row.updatedAt,
				row.id,
			],
		);
		if (rows.length === 0) throw new RowNotFoundError("wager transaction");
	}

	async existsProcessedReversalOf(referenceId: string): Promise<boolean> {
		const rows = await this.tm.current().execute(
			`select 1 as found from wager_transactions
			where reference_transaction_id = ? and kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED'
			limit 1`,
			[referenceId],
		);
		return rows.length > 0;
	}

	async wakeDependents(
		providerId: string,
		externalTransactionId: string,
		walletId: string,
		now: Date,
	): Promise<number> {
		// Restricted to the locked wallet (ADR-0007): no other wallet's rows are touched.
		const rows = await this.tm.current().execute(
			`update wager_transactions set next_attempt_at = ?, updated_at = ?
			where status = 'PENDING_REFERENCE' and provider_id = ?
				and reference_external_transaction_id = ? and wallet_id = ?
			returning id`,
			[now, now, providerId, externalTransactionId, walletId],
		);
		return rows.length;
	}

	async findDuePendingReferences(
		now: Date,
		limit: number,
	): Promise<PendingCandidate[]> {
		// Plain read, no row lock at all: taking the row first would invert the lock order (ADR-0013).
		const rows = (await this.tm.current().execute(
			`select id, wallet_id from wager_transactions
			where status = 'PENDING_REFERENCE' and next_attempt_at <= ?
			order by next_attempt_at, id
			limit ?`,
			[now, limit],
		)) as Array<{ id: string; wallet_id: string }>;
		return rows.map((row) => ({ id: row.id, walletId: row.wallet_id }));
	}

	private async findOneBy(
		where: Partial<WagerTransactionRow>,
	): Promise<WagerTransaction | undefined> {
		const row = await this.tm
			.current()
			.findOne(WagerTransactionRow, where, { disableIdentityMap: true });
		return row === null ? undefined : wagerTransactionToDomain(row);
	}
}
