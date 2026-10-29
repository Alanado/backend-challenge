/** Load generators. Money is always a decimal string (CLAUDE.md), never a `number`. */

/** Deterministic xorshift32, so a run can be repeated with the same seed. */
export function seededRandom(seed: number): () => number {
	let state = seed >>> 0 || 1;
	return () => {
		state ^= state << 13;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state / 2 ** 32;
	};
}

/** Whole-unit amount as the API's decimal string: `amountOf(5)` is `"5.00"`. */
export function amountOf(units: number): string {
	if (!Number.isInteger(units) || units <= 0) {
		throw new Error(`amount units must be a positive integer, got ${units}`);
	}
	return `${units}.00`;
}

export type MixAction = "BET" | "WIN" | "DUPLICATE" | "REFUND" | "LOSS";

/** The N3 mix: 70 % BET, 15 % WIN, 5 % deliberate duplicate, 5 % REFUND, 5 % LOSS. */
const MIX: ReadonlyArray<readonly [MixAction, number]> = [
	["BET", 0.7],
	["WIN", 0.15],
	["DUPLICATE", 0.05],
	["REFUND", 0.05],
	["LOSS", 0.05],
];

export function pickAction(roll: number): MixAction {
	let cumulative = 0;
	for (const [action, share] of MIX) {
		cumulative += share;
		if (roll < cumulative) return action;
	}
	return "BET";
}

/** Random element, removed from the array (each completed BET is referenced at most once). */
export function takeRandom<T>(items: T[], roll: number): T | undefined {
	if (items.length === 0) return undefined;
	const index = Math.min(items.length - 1, Math.floor(roll * items.length));
	const last = items.pop() as T;
	if (index === items.length) return last;
	const taken = items[index] as T;
	items[index] = last;
	return taken;
}

export function peekRandom<T>(
	items: readonly T[],
	roll: number,
): T | undefined {
	if (items.length === 0) return undefined;
	return items[Math.min(items.length - 1, Math.floor(roll * items.length))];
}
