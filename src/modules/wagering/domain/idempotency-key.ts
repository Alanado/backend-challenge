import { InvalidIdempotencyKeyError } from "../../../shared/errors";

// 1..255 printable ASCII characters (0x20-0x7E, space included) — premise P-8.
const PATTERN = /^[\x20-\x7E]{1,255}$/;

export class IdempotencyKey {
	private constructor(public readonly value: string) {}

	static from(value: string): IdempotencyKey {
		if (typeof value !== "string" || !PATTERN.test(value)) {
			throw new InvalidIdempotencyKeyError(
				"idempotency key must be 1 to 255 printable ASCII characters",
			);
		}
		return new IdempotencyKey(value);
	}

	/** Suggested default: `{providerId}:{externalTransactionId}`. */
	static defaultFor(
		providerId: string,
		externalTransactionId: string,
	): IdempotencyKey {
		return IdempotencyKey.from(`${providerId}:${externalTransactionId}`);
	}

	toString(): string {
		return this.value;
	}
}
