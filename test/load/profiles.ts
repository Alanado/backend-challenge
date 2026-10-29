export interface Profile {
	name: string;
	/** Warm-up per HTTP scenario, discarded from the figures. */
	warmupMs: number;
	/** Measured window per HTTP scenario. */
	measureMs: number;
	requestTimeoutMs: number;
	/** N1: many wallets. */
	n1: { wallets: number; concurrency: number };
	/** N2: one hot wallet. */
	n2: { concurrency: number };
	/** N3: mix. */
	n3: { wallets: number; concurrency: number };
	/** N4: SQS. */
	n4: { wallets: number; messages: number; senders: number };
}

export const PROFILES: Record<string, Profile> = {
	// ~5 s per scenario; used by TST-I-22. No throughput is asserted.
	smoke: {
		name: "smoke",
		warmupMs: 500,
		measureMs: 2000,
		requestTimeoutMs: 15_000,
		n1: { wallets: 30, concurrency: 16 },
		n2: { concurrency: 24 },
		n3: { wallets: 20, concurrency: 16 },
		n4: { wallets: 10, messages: 120, senders: 10 },
	},
	// ADR-0021: 10 s warm-up + 30 s measured, 200 wallets, 50 on the hot wallet.
	full: {
		name: "full",
		warmupMs: 10_000,
		measureMs: 30_000,
		requestTimeoutMs: 15_000,
		n1: { wallets: 200, concurrency: 64 },
		n2: { concurrency: 50 },
		n3: { wallets: 50, concurrency: 64 },
		n4: { wallets: 20, messages: 3000, senders: 20 },
	},
};
