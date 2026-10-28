import { describe, expect, test } from "bun:test";
import { LogContext } from "../../../src/modules/platform/application/log-context";
import type { LogFields } from "../../../src/modules/platform/application/log-fields";
import { createPinoLogger } from "../../../src/modules/platform/infrastructure/pino-logger";

function capture() {
	const lines: string[] = [];
	const destination = {
		write(chunk: string) {
			lines.push(chunk);
		},
	};
	const logger = createPinoLogger({ level: "debug", destination });
	return { logger, lines, text: () => lines.join("") };
}

// Values that must never reach the output; each is unique enough to grep for.
const SECRETS = {
	amount: "7771234.56",
	balance: "8881234.56",
	money: "9991234.56",
	payload: "payload-body-secret",
	data: "data-body-secret",
	playerId: "player-0192f298-secret",
	roundId: "round-secret-42",
};

describe("TST-U-12 log redaction", () => {
	test("TST-U-12 forbidden keys at the top level never appear", () => {
		const { logger, text } = capture();
		logger.info({ ...SECRETS, walletId: "w-1" }, "top level");
		for (const secret of Object.values(SECRETS)) {
			expect(text()).not.toContain(secret);
		}
		expect(text()).toContain("w-1");
	});

	test("TST-U-12 forbidden keys nested at several depths never appear", () => {
		const { logger, text } = capture();
		logger.info(
			{
				a: { ...SECRETS },
				b: { c: { ...SECRETS } },
				d: { e: { f: { g: { ...SECRETS } } } },
				list: [{ ...SECRETS }, [{ nested: { ...SECRETS } }]],
				req: { body: { ...SECRETS }, data: SECRETS },
			},
			"nested",
		);
		for (const secret of Object.values(SECRETS)) {
			expect(text()).not.toContain(secret);
		}
	});

	test("TST-U-12 the key match is case-insensitive and covers money-shaped names", () => {
		const { logger, text } = capture();
		logger.info(
			{
				PlayerId: "ci-player",
				ROUNDID: "ci-round",
				Amount: "ci-amount",
				balanceBefore: "ci-before",
				balanceAfter: "ci-after",
				initialBalance: { amount: "ci-initial", currency: "BRL" },
			},
			"case",
		);
		for (const secret of [
			"ci-player",
			"ci-round",
			"ci-amount",
			"ci-before",
			"ci-after",
			"ci-initial",
		]) {
			expect(text()).not.toContain(secret);
		}
	});

	test("TST-U-12 errors keep type, message and stack but drop driver detail fields", () => {
		const { logger, text } = capture();
		const error = Object.assign(new Error("duplicate key value"), {
			detail: `Key (player_id)=(${SECRETS.playerId}) already exists.`,
			parameters: [SECRETS.amount],
			body: { payload: SECRETS.payload },
		});
		logger.error({ err: error, walletId: "w-err" }, "failed");
		for (const secret of Object.values(SECRETS)) {
			expect(text()).not.toContain(secret);
		}
		const line = JSON.parse(text());
		expect(line.err.message).toBe("duplicate key value");
		expect(line.err.type).toBe("Error");
		expect(line.walletId).toBe("w-err");
	});

	test("TST-U-12 output is one JSON object per line with the allowed fields intact", () => {
		const { logger, lines } = capture();
		const fields: LogFields = {
			correlationId: "c-1",
			messageId: "m-1",
			transactionId: "t-1",
			walletId: "w-1",
			providerId: "p-1",
			kind: "BET",
			status: "PROCESSED",
			failureCode: "INSUFFICIENT_FUNDS",
			errorCode: "VALIDATION_ERROR",
			durationMs: 12,
			channel: "http",
		};
		logger.info({ ...fields, ...SECRETS }, "allowed");
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0] ?? "");
		expect(parsed).toMatchObject(fields);
		expect(parsed.msg).toBe("allowed");
		for (const key of Object.keys(SECRETS))
			expect(parsed).not.toHaveProperty(key);
	});

	test("TST-U-12 the log context is injected into every line", async () => {
		const { logger, lines } = capture();
		await LogContext.run({ correlationId: "ctx-1" }, async () => {
			await Promise.resolve();
			LogContext.setWalletId("w-ctx");
			LogContext.setTransactionId("t-ctx");
			LogContext.setProviderId("p-ctx");
			LogContext.setMessageId("m-ctx");
			logger.info("inside");
		});
		logger.info("outside");
		const [inside, outside] = lines.map((l) => JSON.parse(l));
		expect(inside).toMatchObject({
			correlationId: "ctx-1",
			walletId: "w-ctx",
			transactionId: "t-ctx",
			providerId: "p-ctx",
			messageId: "m-ctx",
		});
		expect(outside).not.toHaveProperty("correlationId");
	});

	test("TST-U-12 concurrent contexts do not bleed into each other", async () => {
		const { logger, lines } = capture();
		await Promise.all(
			["a", "b", "c", "d"].map((id) =>
				LogContext.run({ correlationId: id }, async () => {
					await new Promise((r) => setTimeout(r, Math.random() * 10));
					LogContext.setWalletId(`w-${id}`);
					await new Promise((r) => setTimeout(r, Math.random() * 10));
					logger.info(id);
				}),
			),
		);
		for (const line of lines.map((l) => JSON.parse(l))) {
			expect(line.correlationId).toBe(line.msg);
			expect(line.walletId).toBe(`w-${line.msg}`);
		}
	});

	test("TST-U-12 LogFields rejects every forbidden key at compile time", () => {
		// The typecheck gate is the assertion: each @ts-expect-error fails `tsc` if the key ever
		// becomes accepted by LogFields.
		const accepted: LogFields = { walletId: "w" };
		// @ts-expect-error playerId is forbidden in logs (P-1)
		const a: LogFields = { playerId: "p" };
		// @ts-expect-error roundId is forbidden in logs (P-1)
		const b: LogFields = { roundId: "r" };
		// @ts-expect-error monetary values are forbidden in logs
		const c: LogFields = { amount: "1.00" };
		// @ts-expect-error balances are forbidden in logs
		const d: LogFields = { balance: "1.00" };
		// @ts-expect-error payload bodies are forbidden in logs
		const e: LogFields = { payload: {} };
		expect([accepted, a, b, c, d, e]).toHaveLength(6);
	});
});
