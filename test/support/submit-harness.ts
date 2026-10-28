import type { AppLogger } from "../../src/modules/platform/application/log-fields";
import {
	type IdempotentOutcome,
	type LockConflictType,
	MetricsPort,
	type TransactionChannel,
} from "../../src/modules/platform/application/metrics";
import {
	SubmitWagerTransaction,
	type SubmitWagerTransactionCommand,
} from "../../src/modules/wagering/application/submit-wager-transaction";
import { WagerTransactionKind } from "../../src/modules/wagering/domain/wager-transaction-kind";
import type { Clock } from "../../src/shared/clock";
import {
	createFaultInjector,
	type FaultInjector,
} from "../../src/shared/fault-injector";
import { Uuidv7Generator } from "../../src/shared/ids";
import type { MoneyProps } from "../../src/shared/money";
import { uniqueId } from "./ids";
import type { Persistence } from "./persistence";

/** A clock the test moves by hand. */
export class SteppingClock implements Clock {
	constructor(private current = new Date("2026-10-28T12:00:00.000Z")) {}
	now(): Date {
		return new Date(this.current);
	}
	advance(ms: number): void {
		this.current = new Date(this.current.getTime() + ms);
	}
}

export interface ProcessedCall {
	status: string;
	kind: string;
	channel: TransactionChannel;
	failureCode?: string | undefined;
}

/** Records the metric calls a test asserts on; everything else is a no-op. */
export class RecordingMetrics extends MetricsPort {
	readonly processed: ProcessedCall[] = [];
	readonly idempotent: Array<{
		outcome: IdempotentOutcome;
		channel: TransactionChannel;
	}> = [];
	readonly lockConflicts: LockConflictType[] = [];
	readonly durations: Array<{ outcome: string; kind: string }> = [];

	retry(): void {}
	dlqMessage(): void {}
	setOutboxLagSeconds(): void {}
	outboxPublishFailed(): void {}
	reconciliationDivergence(): void {}
	setCircuitBreakerOpen(): void {}

	transactionProcessed(labels: ProcessedCall): void {
		this.processed.push(labels);
	}
	idempotentRequest(
		outcome: IdempotentOutcome,
		channel: TransactionChannel,
	): void {
		this.idempotent.push({ outcome, channel });
	}
	lockConflict(type: LockConflictType): void {
		this.lockConflicts.push(type);
	}
	observeProcessingDuration(
		_seconds: number,
		labels: { channel: TransactionChannel; kind: string; outcome: string },
	): void {
		this.durations.push({ outcome: labels.outcome, kind: labels.kind });
	}
}
export interface LoggedLine {
	level: string;
	message: string;
	fields: Record<string, unknown>;
}

export class RecordingLogger implements AppLogger {
	readonly lines: LoggedLine[] = [];
	private push(level: string, message: string, fields?: object) {
		this.lines.push({ level, message, fields: { ...fields } });
	}
	debug(message: string, fields?: object): void {
		this.push("debug", message, fields);
	}
	info(message: string, fields?: object): void {
		this.push("info", message, fields);
	}
	warn(message: string, fields?: object): void {
		this.push("warn", message, fields);
	}
	error(message: string, fields?: object): void {
		this.push("error", message, fields);
	}
}

export interface HarnessOptions {
	/** `TEST_FAULT` value; default none. */
	fault?: string;
	faults?: FaultInjector;
	clock?: SteppingClock;
}

/** The use case on the real adapters of `p`, with a hand-driven clock and recording doubles. */
export function createSubmitHarness(
	p: Persistence,
	options: HarnessOptions = {},
) {
	const clock = options.clock ?? new SteppingClock();
	const metrics = new RecordingMetrics();
	const logger = new RecordingLogger();
	const submit = new SubmitWagerTransaction({
		tm: p.tm,
		wallets: p.wallets,
		transactions: p.transactions,
		ledger: p.ledger,
		outbox: p.outbox,
		clock,
		ids: new Uuidv7Generator(),
		metrics,
		logger,
		faults: options.faults ?? createFaultInjector(options.fault ?? ""),
	});
	return { submit, clock, metrics, logger };
}

export type SubmitHarness = ReturnType<typeof createSubmitHarness>;

export const SUBMIT_CONTEXT = {
	channel: "http" as const,
	correlationId: "corr-test",
};

export function bet(
	walletId: string,
	playerId: string,
	overrides: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand {
	const externalTransactionId =
		overrides.externalTransactionId ?? `ext-${uniqueId()}`;
	return {
		providerId: "provider-a",
		externalTransactionId,
		idempotencyKey: `${"provider-a"}:${externalTransactionId}`,
		playerId,
		walletId,
		roundId: "round-1",
		gameId: "game-1",
		kind: WagerTransactionKind.Bet,
		money: { amount: "25.00", currency: "BRL" } satisfies MoneyProps,
		...overrides,
	};
}
