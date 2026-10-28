import { InvalidCursorError } from "./errors";

// A `wallet_version` is a positive int4: no sign, no leading zero, no decimals.
const VERSION = /^[1-9]\d{0,9}$/;
const INT4_MAX = 2_147_483_647;

/** Opaque to clients: the base64url of the decimal `wallet_version` of the last item of a page. */
export function encodeLedgerCursor(walletVersion: number): string {
	return Buffer.from(String(walletVersion), "utf8").toString("base64url");
}

/** Only accepts what `encodeLedgerCursor` can produce; anything else is `InvalidCursorError`. */
export function decodeLedgerCursor(cursor: string): number {
	const text = Buffer.from(cursor, "base64url").toString("utf8");
	if (!VERSION.test(text)) throw new InvalidCursorError();
	const version = Number(text);
	// Round trip: rejects padded or otherwise non-canonical spellings of a valid cursor.
	if (version > INT4_MAX || encodeLedgerCursor(version) !== cursor) {
		throw new InvalidCursorError();
	}
	return version;
}
