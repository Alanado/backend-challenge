import { canonicalJson, sha256Hex } from "../../../shared/hash";
import type { Money } from "../../../shared/money";
import type { WagerTransactionKind } from "./wager-transaction-kind";

export interface PayloadHashInput {
	providerId: string;
	externalTransactionId: string;
	playerId: string;
	walletId: string;
	roundId: string;
	gameId: string;
	kind: WagerTransactionKind;
	money: Money;
	referenceExternalTransactionId?: string | undefined;
}

/**
 * SHA-256 of the canonical JSON of the business fields (04-api §6). Reads only
 * the listed subset, so transport metadata (Idempotency-Key, messageId,
 * occurredAt, correlation id) can never leak into the hash.
 */
export function payloadHash(input: PayloadHashInput): string {
	return sha256Hex(
		canonicalJson({
			providerId: input.providerId,
			externalTransactionId: input.externalTransactionId,
			playerId: input.playerId,
			walletId: input.walletId,
			roundId: input.roundId,
			gameId: input.gameId,
			kind: input.kind,
			money: input.money.toJSON(),
			// undefined is omitted by canonicalJson
			referenceExternalTransactionId: input.referenceExternalTransactionId,
		}),
	);
}
