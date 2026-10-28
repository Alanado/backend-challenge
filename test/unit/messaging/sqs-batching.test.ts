import { describe, expect, test } from "bun:test";
import type { PublishEntry } from "../../../src/modules/messaging/application/message-publisher";
import { chunkBySize } from "../../../src/modules/messaging/infrastructure/sqs-message-publisher";

const entry = (id: string, bytes: number): PublishEntry => ({
	id,
	groupKey: "g",
	body: "x".repeat(bytes),
});

describe("SendMessageBatch sizing", () => {
	test("SQSB-01 keeps a batch whose bodies fit the limit in one request", () => {
		const chunks = chunkBySize([entry("a", 100), entry("b", 100)], 200);
		expect(chunks.map((c) => c.map((e) => e.id))).toEqual([["a", "b"]]);
	});

	test("SQSB-02 splits, in order, when the sum would exceed the limit", () => {
		const chunks = chunkBySize(
			[entry("a", 120), entry("b", 120), entry("c", 50)],
			200,
		);
		expect(chunks.map((c) => c.map((e) => e.id))).toEqual([["a"], ["b", "c"]]);
	});

	test("SQSB-03 counts bytes, not characters", () => {
		const multibyte: PublishEntry = {
			id: "m",
			groupKey: "g",
			body: "é".repeat(60),
		};
		const chunks = chunkBySize([multibyte, entry("n", 10)], 125);
		expect(chunks.map((c) => c.map((e) => e.id))).toEqual([["m"], ["n"]]);
	});

	test("SQSB-04 no entries, no requests", () => {
		expect(chunkBySize([], 200)).toEqual([]);
	});
});
