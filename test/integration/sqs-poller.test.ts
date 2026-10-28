import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { MessageHandler } from "../../src/modules/messaging/application/message-consumer";
import { SqsMessageConsumer } from "../../src/modules/messaging/infrastructure/sqs-message-consumer";
import {
	createFaultInjector,
	SimulatedCrashError,
} from "../../src/shared/fault-injector";
import { newSqsClient } from "../support/event-consumer";
import { eventually } from "../support/eventually";
import {
	deferred,
	queueDepth,
	RecordingHandler,
	sendMessage,
} from "../support/sqs-poller";
import { RecordingLogger } from "../support/submit-harness";
import { createSuiteQueues, type SuiteQueues } from "../support/suite-queues";

const sqs = newSqsClient();
/** How long a negative assertion ("this did not happen") watches before it concludes. */
const OBSERVATION_MS = 400;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(() => sqs.destroy());

interface Rig {
	queues: SuiteQueues;
	consumer: SqsMessageConsumer;
	send(body: string, group: string): Promise<void>;
	/** Commands the consumer sent, in order (a spy over the real client). */
	commands: Array<{ name: string; input: Record<string, unknown> }>;
}

async function createRig(
	handler: MessageHandler,
	options: {
		visibilityTimeoutS?: number;
		handlerTimeoutMs?: number;
		waitTimeSeconds?: number;
		concurrency?: number;
		crashOnce?: boolean;
	} = {},
): Promise<Rig> {
	const queues = await createSuiteQueues("poller", {
		visibilityTimeoutS: options.visibilityTimeoutS ?? 30,
	});
	const client: SQSClient = newSqsClient();
	const commands: Rig["commands"] = [];
	const send = client.send.bind(client) as (
		command: { constructor: { name: string }; input: object },
		...rest: unknown[]
	) => Promise<unknown>;
	(client as unknown as { send: typeof send }).send = (command, ...rest) => {
		commands.push({
			name: command.constructor.name,
			input: { ...command.input },
		});
		return send(command, ...rest);
	};
	let crashed = false;
	const consumer = new SqsMessageConsumer({
		client,
		queueName: queues.main.name,
		concurrency: options.concurrency ?? 5,
		handlerTimeoutMs: options.handlerTimeoutMs ?? 10_000,
		waitTimeSeconds: options.waitTimeSeconds ?? 1,
		faults: createFaultInjector(
			options.crashOnce ? "crash-after-commit-before-ack" : "",
			(point) => {
				if (crashed) return;
				crashed = true;
				throw new SimulatedCrashError(point);
			},
		),
		logger: new RecordingLogger(),
	});
	consumer.register(handler);
	cleanups.push(async () => {
		await consumer.stop();
		client.destroy();
		await queues.destroy();
	});
	return {
		queues,
		consumer,
		commands,
		send: (body, group) => sendMessage(sqs, queues.main.url, body, group),
	};
}

describe("X-POLLER ordering and concurrency", () => {
	test("X-POLLER-01 messages of one group run in the order received, never overlapping", async () => {
		const recorder = new RecordingHandler(async () => {
			await Bun.sleep(30);
			return { kind: "ack" };
		});
		const rig = await createRig(recorder.handle);
		for (const n of [1, 2, 3, 4, 5]) await rig.send(`a${n}`, "wallet-a");

		rig.consumer.start();
		await eventually(() => expect(recorder.calls).toHaveLength(5));

		expect(recorder.bodies()).toEqual(["a1", "a2", "a3", "a4", "a5"]);
		expect(recorder.maxActiveInAGroup).toBe(1);
		await eventually(async () =>
			expect(await queueDepth(sqs, rig.queues.main.url)).toBe(0),
		);
	});

	test("X-POLLER-02 handlers of different groups really overlap", async () => {
		const started = new Set<string>();
		const allStarted = deferred();
		const recorder = new RecordingHandler(async (message) => {
			started.add(message.groupId);
			if (started.size === 3) allStarted.resolve();
			// Each handler returns only once all three are running: overlap is forced, not hoped for.
			await Promise.race([allStarted.promise, Bun.sleep(4000)]);
			return { kind: "ack" };
		});
		const rig = await createRig(recorder.handle);
		await rig.send("a", "wallet-a");
		await rig.send("b", "wallet-b");
		await rig.send("c", "wallet-c");

		rig.consumer.start();
		await eventually(() => expect(recorder.calls).toHaveLength(3));

		expect(recorder.maxActive).toBe(3);
		expect(recorder.maxActiveInAGroup).toBe(1);
	});

	test("X-POLLER-03 concurrency between groups is capped at SQS_CONCURRENCY", async () => {
		const recorder = new RecordingHandler(async () => {
			await Bun.sleep(150);
			return { kind: "ack" };
		});
		const rig = await createRig(recorder.handle, { concurrency: 2 });
		for (const group of ["a", "b", "c", "d", "e"]) await rig.send(group, group);

		rig.consumer.start();
		await eventually(() => expect(recorder.calls).toHaveLength(5));

		expect(recorder.maxActive).toBe(2);
	});

	test("X-POLLER-04 a group in a batch does not wait for a slow handler of another group", async () => {
		const release = deferred();
		const recorder = new RecordingHandler(async (message) => {
			if (message.body === "slow") await release.promise;
			return { kind: "ack" };
		});
		const rig = await createRig(recorder.handle);
		await rig.send("slow", "wallet-a");
		await rig.send("fast", "wallet-b");

		rig.consumer.start();
		await eventually(() => expect(recorder.bodies()).toContain("fast"));
		await eventually(async () =>
			expect(await queueDepth(sqs, rig.queues.main.url)).toBe(1),
		);
		release.resolve();
		await eventually(async () =>
			expect(await queueDepth(sqs, rig.queues.main.url)).toBe(0),
		);
	});
});

describe("X-POLLER acknowledgement and visibility", () => {
	test("X-POLLER-05 a handled message is deleted, and only then", async () => {
		const gate = deferred();
		const recorder = new RecordingHandler(async () => {
			await gate.promise;
			return { kind: "ack" };
		});
		const rig = await createRig(recorder.handle);
		await rig.send("m1", "wallet-a");

		rig.consumer.start();
		await eventually(() => expect(recorder.calls).toHaveLength(1));
		// The handler is still running: nothing may have been deleted yet.
		expect(rig.commands.map((c) => c.name)).not.toContain(
			"DeleteMessageCommand",
		);
		expect(await queueDepth(sqs, rig.queues.main.url)).toBe(1);

		gate.resolve();
		await eventually(async () =>
			expect(await queueDepth(sqs, rig.queues.main.url)).toBe(0),
		);
		expect(rig.commands.map((c) => c.name)).toContain("DeleteMessageCommand");
	});

	test("X-POLLER-06 a handler slower than the timeout is not deleted and the message comes back", async () => {
		const recorder = new RecordingHandler(async (_message, call) => {
			if (call.receiveCount === 1) await Bun.sleep(1500);
			return { kind: "ack" };
		});
		const rig = await createRig(recorder.handle, { handlerTimeoutMs: 200 });
		await rig.send("slow-once", "wallet-a");

		rig.consumer.start();
		await eventually(() =>
			expect(recorder.calls.map((c) => c.receiveCount)).toEqual([1, 2]),
		);
		await eventually(async () =>
			expect(await queueDepth(sqs, rig.queues.main.url)).toBe(0),
		);
	});

	test("X-POLLER-07 a transient failure keeps the message and hands back the rest of the group", async () => {
		const recorder = new RecordingHandler(async (_message, call) =>
			call.body === "m1" && call.receiveCount === 1
				? { kind: "retry", delaySeconds: 1 }
				: { kind: "ack" },
		);
		const rig = await createRig(recorder.handle);
		for (const body of ["m1", "m2", "m3"]) await rig.send(body, "wallet-a");

		rig.consumer.start();
		await eventually(() => expect(recorder.calls).toHaveLength(4));

		// m1 failed on delivery 1; m2 and m3 were received in that batch but NOT processed: their
		// first handler call is on delivery 2. The relative order of the redeliveries is not
		// asserted: LocalStack hands m2/m3 back before m1's delay ends (see the W9 report).
		expect(recorder.calls[0]).toEqual({
			body: "m1",
			receiveCount: 1,
			groupId: "wallet-a",
		});
		expect(
			recorder.calls
				.slice(1)
				.map((c) => `${c.body}:${c.receiveCount}`)
				.sort(),
		).toEqual(["m1:2", "m2:2", "m3:2"]);
		const visibilities = rig.commands
			.filter((c) => c.name === "ChangeMessageVisibilityCommand")
			.map((c) => c.input.VisibilityTimeout);
		expect(visibilities).toEqual([1, 0, 0]);
	});

	test("X-POLLER-08 a thrown error is not an ack: the message returns at once", async () => {
		const recorder = new RecordingHandler(async (_message, call) => {
			if (call.receiveCount === 1) throw new Error("boom");
			return { kind: "ack" };
		});
		const rig = await createRig(recorder.handle);
		await rig.send("m1", "wallet-a");

		rig.consumer.start();
		await eventually(() =>
			expect(recorder.calls.map((c) => c.receiveCount)).toEqual([1, 2]),
		);
	});

	test("X-POLLER-09 a crash between the handler and the delete leaves the message to come back", async () => {
		const recorder = new RecordingHandler();
		const rig = await createRig(recorder.handle, {
			visibilityTimeoutS: 1,
			crashOnce: true,
		});
		await rig.send("m1", "wallet-a");

		rig.consumer.start();
		await eventually(
			() => expect(recorder.calls.map((c) => c.receiveCount)).toEqual([1, 2]),
			{ timeout: 10_000 },
		);
		await eventually(async () =>
			expect(await queueDepth(sqs, rig.queues.main.url)).toBe(0),
		);
		// One delete only: the one after the second, surviving, handling.
		expect(
			rig.commands.filter((c) => c.name === "DeleteMessageCommand"),
		).toHaveLength(1);
	});
});

describe("X-POLLER fetching and stopping", () => {
	test("X-POLLER-10 long polling: receives with WaitTimeSeconds and wakes for a message sent meanwhile", async () => {
		const recorder = new RecordingHandler();
		const rig = await createRig(recorder.handle, { waitTimeSeconds: 5 });

		rig.consumer.start();
		await eventually(() =>
			expect(rig.commands.some((c) => c.name === "ReceiveMessageCommand")).toBe(
				true,
			),
		);
		const sentAt = performance.now();
		await rig.send("late", "wallet-a");
		await eventually(() => expect(recorder.calls).toHaveLength(1), {
			timeout: 4000,
		});

		// Woken by the message, well before the 5 s wait would have ended.
		expect(performance.now() - sentAt).toBeLessThan(4000);
		const receive = rig.commands.find(
			(c) => c.name === "ReceiveMessageCommand",
		);
		expect(receive?.input).toMatchObject({
			MaxNumberOfMessages: 10,
			WaitTimeSeconds: 5,
		});
		expect(receive?.input.MessageSystemAttributeNames).toEqual([
			"ApproximateReceiveCount",
			"MessageGroupId",
			"MessageDeduplicationId",
		]);
	});

	test("X-POLLER-11 stop() waits for the handler in flight and then the message is acked", async () => {
		const gate = deferred();
		const recorder = new RecordingHandler(async () => {
			await gate.promise;
			return { kind: "ack" };
		});
		const rig = await createRig(recorder.handle);
		await rig.send("m1", "wallet-a");
		rig.consumer.start();
		await eventually(() => expect(recorder.calls).toHaveLength(1));

		let stopped = false;
		const stopping = rig.consumer.stop().then(() => {
			stopped = true;
		});
		await Bun.sleep(OBSERVATION_MS);
		expect(stopped).toBe(false);

		gate.resolve();
		await stopping;
		expect(stopped).toBe(true);
		expect(await queueDepth(sqs, rig.queues.main.url)).toBe(0);
	});

	test("X-POLLER-12 stop() interrupts an idle long poll instead of waiting it out", async () => {
		const recorder = new RecordingHandler();
		const rig = await createRig(recorder.handle, { waitTimeSeconds: 20 });
		rig.consumer.start();
		await eventually(() =>
			expect(rig.commands.some((c) => c.name === "ReceiveMessageCommand")).toBe(
				true,
			),
		);

		const startedAt = performance.now();
		await rig.consumer.stop();

		expect(performance.now() - startedAt).toBeLessThan(2000);
	});

	test("X-POLLER-13 nothing is handled after stop()", async () => {
		const recorder = new RecordingHandler();
		const rig = await createRig(recorder.handle);
		rig.consumer.start();
		await rig.consumer.stop();

		await rig.send("after-stop", "wallet-a");
		await Bun.sleep(OBSERVATION_MS * 3);

		expect(recorder.calls).toHaveLength(0);
		expect(await queueDepth(sqs, rig.queues.main.url)).toBe(1);
	});
});
