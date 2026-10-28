import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { MessageHandler } from "../../src/modules/messaging/application/message-consumer";
import { SqsDeadLetterQueue } from "../../src/modules/messaging/infrastructure/sqs-dead-letter-queue";
import { SqsMessageConsumer } from "../../src/modules/messaging/infrastructure/sqs-message-consumer";
import { createFaultInjector } from "../../src/shared/fault-injector";
import { newSqsClient } from "../support/event-consumer";
import { eventually, holdsFor } from "../support/eventually";
import {
	deferred,
	queueCounts,
	RecordingHandler,
	sendMessage,
} from "../support/sqs-poller";
import { RecordingLogger, RecordingMetrics } from "../support/submit-harness";
import { createSuiteQueues, type SuiteQueues } from "../support/suite-queues";

const sqs = newSqsClient();
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
	shutdownGraceMs: number | undefined,
	concurrency = 5,
): Promise<Rig> {
	// Long visibility: a message that is visible again can only be one the consumer returned.
	const queues = await createSuiteQueues("shutdown", {
		visibilityTimeoutS: 60,
	});
	const client = newSqsClient();
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
	const consumer = new SqsMessageConsumer({
		client,
		queueName: queues.main.name,
		concurrency,
		handlerTimeoutMs: 30_000,
		waitTimeSeconds: 1,
		faults: createFaultInjector(""),
		logger: new RecordingLogger(),
		metrics: new RecordingMetrics(),
		deadLetter: new SqsDeadLetterQueue({ client, queueName: queues.dlq.name }),
		...(shutdownGraceMs === undefined ? {} : { shutdownGraceMs }),
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

describe("TST-I-18 the consumer on shutdown (real SQS)", () => {
	test("TST-I-18 handlers that finish within the grace period are acknowledged, and stop() resolves only after them", async () => {
		const release = deferred();
		const recorder = new RecordingHandler(async () => {
			await release.promise;
			return { kind: "ack" };
		});
		const rig = await createRig(recorder.handle, 10_000);
		for (const group of ["a", "b", "c"]) await rig.send(`m-${group}`, group);
		rig.consumer.start();
		await eventually(() => expect(recorder.calls).toHaveLength(3));

		let stopped = false;
		const stopping = rig.consumer.stop().then(() => {
			stopped = true;
		});
		await holdsFor(300, () => expect(stopped).toBe(false), 50);
		release.resolve();
		await stopping;

		expect(
			rig.commands.filter((c) => c.name === "DeleteMessageCommand"),
		).toHaveLength(3);
		expect(await queueCounts(sqs, rig.queues.main.url)).toEqual({
			visible: 0,
			inFlight: 0,
			delayed: 0,
		});
	});

	test("TST-I-18 when the grace period ends, handlers still running are returned (visibility 0), not deleted, and their late outcome changes nothing", async () => {
		const never = deferred();
		const recorder = new RecordingHandler(async () => {
			await never.promise;
			return { kind: "ack" };
		});
		// Concurrency 2 with three groups: two handlers hang, the third group waits for a slot.
		const rig = await createRig(recorder.handle, 400, 2);
		for (const group of ["a", "b", "c"]) await rig.send(`m-${group}`, group);
		rig.consumer.start();
		await eventually(() => expect(recorder.calls).toHaveLength(2));
		await eventually(async () =>
			expect(await queueCounts(sqs, rig.queues.main.url)).toMatchObject({
				inFlight: 3,
			}),
		);

		const stopStart = performance.now();
		await rig.consumer.stop();
		const stopMs = performance.now() - stopStart;
		expect(stopMs).toBeGreaterThanOrEqual(350);
		expect(stopMs).toBeLessThan(3000);

		// All three are deliverable again at once: the two held and the one that never got a slot.
		await eventually(async () =>
			expect(await queueCounts(sqs, rig.queues.main.url)).toEqual({
				visible: 3,
				inFlight: 0,
				delayed: 0,
			}),
		);
		expect(
			rig.commands.filter((c) => c.name === "DeleteMessageCommand"),
		).toEqual([]);
		const returned = rig.commands.filter(
			(c) => c.name === "ChangeMessageVisibilityCommand",
		);
		expect(returned).toHaveLength(3);
		expect(returned.every((c) => c.input.VisibilityTimeout === 0)).toBe(true);

		// The hung handlers finally answer `ack`: nothing is deleted, nothing else is sent.
		const before = rig.commands.length;
		never.resolve();
		await holdsFor(
			500,
			() => {
				expect(rig.commands.length).toBe(before);
			},
			50,
		);
		expect(await queueCounts(sqs, rig.queues.main.url)).toMatchObject({
			visible: 3,
		});
	});
});
