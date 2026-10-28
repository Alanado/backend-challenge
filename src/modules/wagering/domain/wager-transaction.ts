import {
	InvalidReferenceRequirementError,
	InvalidTransactionStateError,
	LedgerDirectionUnavailableError,
} from "../../../shared/errors";
import type { Money } from "../../../shared/money";
import { LedgerDirection } from "../../wallet/domain/wallet-ledger-entry";
import type { FailureCode } from "./failure-code";
import { WagerTransactionKind } from "./wager-transaction-kind";
import { WagerTransactionStatus } from "./wager-transaction-status";

const { Pending, PendingReference, Processed, Rejected, Failed } =
	WagerTransactionStatus;

export interface WagerTransactionState {
	id: string;
	providerId: string;
	externalTransactionId: string;
	idempotencyKey: string;
	payloadHash: string;
	walletId: string;
	playerId: string;
	roundId: string;
	gameId: string;
	kind: WagerTransactionKind;
	money: Money;
	/** Id at the provider — not the internal id. */
	referenceExternalTransactionId: string | undefined;
	createdAt: Date;
	status: WagerTransactionStatus;
	referenceTransactionId: string | undefined;
	failureCode: FailureCode | undefined;
	processedAt: Date | undefined;
	/** Wallet balance seen when the outcome was decided; replays return it. */
	observedBalance: Money | undefined;
	referenceAttempts: number;
	nextAttemptAt: Date | undefined;
}

export type CreateWagerTransactionProps = Pick<
	WagerTransactionState,
	| "id"
	| "providerId"
	| "externalTransactionId"
	| "idempotencyKey"
	| "payloadHash"
	| "walletId"
	| "playerId"
	| "roundId"
	| "gameId"
	| "kind"
	| "money"
> & {
	referenceExternalTransactionId?: string | undefined;
	now: Date;
};

export class WagerTransaction {
	private constructor(private state: WagerTransactionState) {}

	/** Born PENDING. Validates the reference requirement of the kind. */
	static create(props: CreateWagerTransactionProps): WagerTransaction {
		const { kind } = props;
		const reference = props.referenceExternalTransactionId;
		const hasReference = reference !== undefined && reference !== "";
		if (
			(kind === WagerTransactionKind.Refund ||
				kind === WagerTransactionKind.Rollback) &&
			!hasReference
		) {
			throw new InvalidReferenceRequirementError(
				`${kind} requires a reference`,
			);
		}
		if (
			(kind === WagerTransactionKind.Bet ||
				kind === WagerTransactionKind.Opening) &&
			reference !== undefined
		) {
			throw new InvalidReferenceRequirementError(
				`${kind} must not carry a reference`,
			);
		}
		return new WagerTransaction({
			id: props.id,
			providerId: props.providerId,
			externalTransactionId: props.externalTransactionId,
			idempotencyKey: props.idempotencyKey,
			payloadHash: props.payloadHash,
			walletId: props.walletId,
			playerId: props.playerId,
			roundId: props.roundId,
			gameId: props.gameId,
			kind,
			money: props.money,
			referenceExternalTransactionId: hasReference ? reference : undefined,
			createdAt: props.now,
			status: Pending,
			referenceTransactionId: undefined,
			failureCode: undefined,
			processedAt: undefined,
			observedBalance: undefined,
			referenceAttempts: 0,
			nextAttemptAt: undefined,
		});
	}

	/** Rebuilds persisted state (any status, terminal included); does not revalidate. */
	static rehydrate(state: WagerTransactionState): WagerTransaction {
		return new WagerTransaction({ ...state });
	}

	get id(): string {
		return this.state.id;
	}
	get providerId(): string {
		return this.state.providerId;
	}
	get externalTransactionId(): string {
		return this.state.externalTransactionId;
	}
	get idempotencyKey(): string {
		return this.state.idempotencyKey;
	}
	get payloadHash(): string {
		return this.state.payloadHash;
	}
	get walletId(): string {
		return this.state.walletId;
	}
	get playerId(): string {
		return this.state.playerId;
	}
	get roundId(): string {
		return this.state.roundId;
	}
	get gameId(): string {
		return this.state.gameId;
	}
	get kind(): WagerTransactionKind {
		return this.state.kind;
	}
	get money(): Money {
		return this.state.money;
	}
	get referenceExternalTransactionId(): string | undefined {
		return this.state.referenceExternalTransactionId;
	}
	get createdAt(): Date {
		return this.state.createdAt;
	}
	get status(): WagerTransactionStatus {
		return this.state.status;
	}
	get referenceTransactionId(): string | undefined {
		return this.state.referenceTransactionId;
	}
	get failureCode(): FailureCode | undefined {
		return this.state.failureCode;
	}
	get processedAt(): Date | undefined {
		return this.state.processedAt;
	}
	get observedBalance(): Money | undefined {
		return this.state.observedBalance;
	}
	get referenceAttempts(): number {
		return this.state.referenceAttempts;
	}
	get nextAttemptAt(): Date | undefined {
		return this.state.nextAttemptAt;
	}

	// Transitions. Valid ones (anything from a terminal state throws):
	//   PENDING           -> PROCESSED | REJECTED | PENDING_REFERENCE | FAILED
	//   PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED

	markProcessed(
		referenceTransactionId: string | undefined,
		at: Date,
		observedBalance?: Money,
	): void {
		this.assertOpen("markProcessed");
		this.state.status = Processed;
		this.state.referenceTransactionId = referenceTransactionId;
		this.state.processedAt = at;
		this.state.observedBalance = observedBalance;
		this.state.nextAttemptAt = undefined;
	}

	/** First entry into PENDING_REFERENCE; the first attempt is not counted. */
	markPendingReference(nextAttemptAt: Date): void {
		if (this.state.status !== Pending) {
			throw new InvalidTransactionStateError(
				this.state.status,
				"markPendingReference",
			);
		}
		this.state.status = PendingReference;
		this.state.nextAttemptAt = nextAttemptAt;
	}

	/**
	 * A retry that is still pending is NOT a transition: it counts the attempt
	 * and reschedules.
	 */
	rescheduleReference(nextAttemptAt: Date): void {
		if (this.state.status !== PendingReference) {
			throw new InvalidTransactionStateError(
				this.state.status,
				"rescheduleReference",
			);
		}
		this.state.referenceAttempts += 1;
		this.state.nextAttemptAt = nextAttemptAt;
	}

	reject(code: FailureCode, observedBalance?: Money): void {
		this.assertOpen("reject");
		this.state.status = Rejected;
		this.state.failureCode = code;
		this.state.observedBalance = observedBalance;
		this.state.nextAttemptAt = undefined;
	}

	fail(code: FailureCode): void {
		this.assertOpen("fail");
		this.state.status = Failed;
		this.state.failureCode = code;
		this.state.nextAttemptAt = undefined;
	}

	isTerminal(): boolean {
		const { status } = this.state;
		return status === Processed || status === Rejected || status === Failed;
	}

	/** False only for LOSS. */
	affectsBalance(): boolean {
		return this.state.kind !== WagerTransactionKind.Loss;
	}

	requiresReference(): boolean {
		return (
			this.state.kind === WagerTransactionKind.Refund ||
			this.state.kind === WagerTransactionKind.Rollback
		);
	}

	matchesPayload(payloadHash: string): boolean {
		return this.state.payloadHash === payloadHash;
	}

	/**
	 * OPENING/WIN/REFUND credit; BET debits; ROLLBACK is the inverse of the
	 * referenced transaction (BET->CREDIT, WIN->DEBIT, REFUND->DEBIT).
	 */
	ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
		switch (this.state.kind) {
			case WagerTransactionKind.Opening:
			case WagerTransactionKind.Win:
			case WagerTransactionKind.Refund:
				return LedgerDirection.Credit;
			case WagerTransactionKind.Bet:
				return LedgerDirection.Debit;
			case WagerTransactionKind.Loss:
				throw new LedgerDirectionUnavailableError("LOSS has no ledger entry");
			case WagerTransactionKind.Rollback:
				return WagerTransaction.inverseOf(reference);
		}
	}

	private static inverseOf(reference?: WagerTransaction): LedgerDirection {
		if (reference === undefined) {
			throw new LedgerDirectionUnavailableError(
				"ROLLBACK needs its reference to know the direction",
			);
		}
		switch (reference.kind) {
			case WagerTransactionKind.Bet:
				return LedgerDirection.Credit;
			case WagerTransactionKind.Win:
			case WagerTransactionKind.Refund:
				return LedgerDirection.Debit;
			default:
				throw new LedgerDirectionUnavailableError(
					`ROLLBACK of ${reference.kind} is not reversible`,
				);
		}
	}

	private assertOpen(operation: string): void {
		if (this.isTerminal()) {
			throw new InvalidTransactionStateError(this.state.status, operation);
		}
	}
}
