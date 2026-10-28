import { AsyncLocalStorage } from "node:async_hooks";

/** Per request/message context the logger injects into every line (RF-OBS-01). */
export interface LogContextFields {
	correlationId?: string;
	messageId?: string;
	transactionId?: string;
	walletId?: string;
	providerId?: string;
}

const storage = new AsyncLocalStorage<LogContextFields>();

export const LogContext = {
	/** Runs `work` with a fresh context; everything it awaits sees (and can extend) it. */
	run<T>(initial: LogContextFields, work: () => T): T {
		return storage.run({ ...initial }, work);
	},
	/** Merges `fields` into the current context; a no-op outside `run`. */
	set(fields: LogContextFields): void {
		const current = storage.getStore();
		if (current !== undefined) Object.assign(current, fields);
	},
	setCorrelationId(correlationId: string): void {
		LogContext.set({ correlationId });
	},
	setMessageId(messageId: string): void {
		LogContext.set({ messageId });
	},
	setTransactionId(transactionId: string): void {
		LogContext.set({ transactionId });
	},
	setWalletId(walletId: string): void {
		LogContext.set({ walletId });
	},
	setProviderId(providerId: string): void {
		LogContext.set({ providerId });
	},
	current(): Readonly<LogContextFields> {
		return storage.getStore() ?? {};
	},
};
