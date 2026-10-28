// Spike R-01/R-03 (T-003): AWS SDK v3 no Bun + semântica FIFO/DLQ do emulador SQS.
// Pré-requisito: emulador no ar (`bun run test:infra:up`). Variáveis opcionais:
// SPIKE_SQS_ENDPOINT (padrão http://localhost:4567) e SPIKE_SQS_CONTAINER (padrão wagering-test-sqs-1, para medir RAM).
import {
	ChangeMessageVisibilityCommand,
	CreateQueueCommand,
	DeleteMessageCommand,
	DeleteQueueCommand,
	GetQueueAttributesCommand,
	GetQueueUrlCommand,
	type Message,
	ReceiveMessageCommand,
	SendMessageBatchCommand,
	SendMessageCommand,
	SQSClient,
} from "@aws-sdk/client-sqs";
import { assert, check, finish, note } from "../lib/check";

const endpoint = process.env.SPIKE_SQS_ENDPOINT ?? "http://localhost:4567";
const sqs = new SQSClient({
	region: "us-east-1",
	endpoint,
	credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
const run = Math.random().toString(36).slice(2, 8);
const createdUrls: string[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function createFifo(
	name: string,
	attributes: Record<string, string> = {},
): Promise<{ url: string; arn: string }> {
	const { QueueUrl } = await sqs.send(
		new CreateQueueCommand({
			QueueName: `${name}-${run}.fifo`,
			Attributes: { FifoQueue: "true", ...attributes },
		}),
	);
	assert(QueueUrl, "CreateQueue sem QueueUrl");
	createdUrls.push(QueueUrl);
	const attrs = await sqs.send(
		new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] }),
	);
	return { url: QueueUrl, arn: attrs.Attributes?.QueueArn ?? "" };
}

function send(
	url: string,
	body: string,
	group: string,
	dedup = `${body}-${Math.random()}`,
) {
	return sqs.send(
		new SendMessageCommand({
			QueueUrl: url,
			MessageBody: body,
			MessageGroupId: group,
			MessageDeduplicationId: dedup,
		}),
	);
}

async function receive(
	url: string,
	opts: { max?: number; wait?: number; visibility?: number } = {},
): Promise<Message[]> {
	const out = await sqs.send(
		new ReceiveMessageCommand({
			QueueUrl: url,
			MaxNumberOfMessages: opts.max ?? 10,
			WaitTimeSeconds: opts.wait ?? 0,
			VisibilityTimeout: opts.visibility,
			MessageSystemAttributeNames: [
				"ApproximateReceiveCount",
				"MessageGroupId",
			],
		}),
	);
	return out.Messages ?? [];
}

async function del(url: string, message: Message): Promise<void> {
	await sqs.send(
		new DeleteMessageCommand({
			QueueUrl: url,
			ReceiptHandle: message.ReceiptHandle,
		}),
	);
}

async function eventually<T>(
	fn: () => Promise<T | undefined>,
	timeoutMs: number,
	what: string,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await fn();
		if (value !== undefined) return value;
		await sleep(250);
	}
	throw new Error(`timeout esperando: ${what}`);
}

await check(
	"1",
	"SDK v3 no Bun: Send/SendBatch/Receive/Delete/ChangeVisibility/GetQueueAttributes",
	async () => {
		const q = await createFifo("ops", { VisibilityTimeout: "30" });
		const sent = await send(q.url, "hello", "g");
		assert(sent.MessageId, "SendMessage sem MessageId");
		const batch = await sqs.send(
			new SendMessageBatchCommand({
				QueueUrl: q.url,
				Entries: [
					{
						Id: "1",
						MessageBody: "b1",
						MessageGroupId: "g",
						MessageDeduplicationId: `b1-${run}`,
					},
				],
			}),
		);
		assert(batch.Successful?.length === 1, "SendMessageBatch");
		const got = await receive(q.url);
		assert(got.length >= 1, "ReceiveMessage vazio");
		const first = got[0] as Message;
		await sqs.send(
			new ChangeMessageVisibilityCommand({
				QueueUrl: q.url,
				ReceiptHandle: first.ReceiptHandle,
				VisibilityTimeout: 5,
			}),
		);
		for (const m of got) await del(q.url, m);
		const attrs = await sqs.send(
			new GetQueueAttributesCommand({
				QueueUrl: q.url,
				AttributeNames: ["All"],
			}),
		);
		assert(
			attrs.Attributes?.FifoQueue === "true",
			"GetQueueAttributes FifoQueue",
		);
		return "6 operações ok";
	},
);

await check(
	"2",
	"FIFO + DLQ FIFO com redrivePolicy: após N recebimentos sem delete a mensagem vai à DLQ",
	async () => {
		const dlq = await createFifo("dlq");
		const main = await createFifo("redrive", {
			VisibilityTimeout: "1",
			RedrivePolicy: JSON.stringify({
				deadLetterTargetArn: dlq.arn,
				maxReceiveCount: 2,
			}),
		});
		const attrs = await sqs.send(
			new GetQueueAttributesCommand({
				QueueUrl: main.url,
				AttributeNames: ["RedrivePolicy"],
			}),
		);
		const policy = JSON.parse(attrs.Attributes?.RedrivePolicy ?? "{}");
		assert(
			Number(policy.maxReceiveCount) === 2 &&
				policy.deadLetterTargetArn === dlq.arn,
			`RedrivePolicy lida: ${JSON.stringify(policy)}`,
		);
		await send(main.url, "poison", "g1");
		const counts: number[] = [];
		const inDlq = await eventually(
			async () => {
				const fromMain = await receive(main.url, { visibility: 1 });
				for (const m of fromMain)
					counts.push(Number(m.Attributes?.ApproximateReceiveCount));
				const fromDlq = await receive(dlq.url);
				return fromDlq[0];
			},
			25_000,
			"mensagem na DLQ",
		);
		assert(inDlq.Body === "poison", "corpo na DLQ");
		assert(
			counts.length === 2 && counts[0] === 1 && counts[1] === 2,
			`recebimentos antes da DLQ: ${counts}`,
		);
		return `recebida ${counts.length}x (ApproximateReceiveCount ${counts}) e movida à DLQ FIFO`;
	},
);

await check(
	"3a",
	"MessageGroupId: ordem preservada dentro do grupo",
	async () => {
		const q = await createFifo("order", { VisibilityTimeout: "30" });
		for (let i = 1; i <= 5; i++) await send(q.url, `a${i}`, "A");
		const seen: string[] = [];
		await eventually(
			async () => {
				const msgs = await receive(q.url);
				for (const m of msgs) {
					seen.push(m.Body ?? "");
					await del(q.url, m);
				}
				return seen.length >= 5 ? true : undefined;
			},
			10_000,
			"5 mensagens",
		);
		assert(seen.join(",") === "a1,a2,a3,a4,a5", `ordem: ${seen}`);
		return seen.join(",");
	},
);

await check(
	"3b",
	"bloqueio de cabeça de fila: com A1 em voo, A2 não é entregue; grupo B entrega",
	async () => {
		const q = await createFifo("hol", { VisibilityTimeout: "30" });
		await send(q.url, "a1", "A");
		const first = await receive(q.url);
		assert(
			first.length === 1 && first[0]?.Body === "a1",
			"a1 deveria ser entregue",
		);
		await send(q.url, "a2", "A");
		await send(q.url, "b1", "B");
		await sleep(300);
		const second = await receive(q.url);
		const bodies = second.map((m) => m.Body);
		assert(
			!bodies.includes("a2"),
			`a2 não deveria ser entregue com a1 em voo: ${bodies}`,
		);
		assert(
			bodies.includes("b1"),
			`grupo B deveria entregar em paralelo: ${bodies}`,
		);
		await del(q.url, first[0] as Message);
		const third = await eventually(
			async () => {
				const msgs = await receive(q.url);
				return msgs.find((m) => m.Body === "a2");
			},
			5_000,
			"a2 após delete de a1",
		);
		assert(third.Body === "a2", "a2 liberada");
		return "a2 bloqueada enquanto a1 em voo; b1 entregue; a2 liberada após delete";
	},
);

await check(
	"3c",
	"informativo: um único ReceiveMessage pode devolver várias do mesmo grupo?",
	async () => {
		const q = await createFifo("batchgroup", { VisibilityTimeout: "30" });
		for (let i = 1; i <= 3; i++) await send(q.url, `x${i}`, "X");
		await sleep(300);
		const msgs = await receive(q.url);
		return `mesmo grupo no mesmo lote: ${msgs.length} mensagens (${msgs.map((m) => m.Body)})`;
	},
);

await check(
	"4",
	"MessageDeduplicationId: duplicata na janela não é entregue duas vezes",
	async () => {
		const q = await createFifo("dedup", { VisibilityTimeout: "1" });
		const a = await send(q.url, "original", "g", `dedup-${run}`);
		const b = await send(q.url, "duplicate", "g", `dedup-${run}`);
		await sleep(300);
		const bodies: string[] = [];
		for (let i = 0; i < 3; i++) {
			for (const m of await receive(q.url)) {
				bodies.push(m.Body ?? "");
				await del(q.url, m);
			}
		}
		assert(
			bodies.length === 1 && bodies[0] === "original",
			`entregas: ${bodies}`,
		);
		return `2 envios, 1 entrega; MessageId igual=${a.MessageId === b.MessageId}`;
	},
);

await check(
	"5",
	"long polling (WaitTimeSeconds) + ApproximateReceiveCount e MessageGroupId",
	async () => {
		const q = await createFifo("poll", { VisibilityTimeout: "30" });
		let started = Date.now();
		const empty = await receive(q.url, { wait: 2 });
		const emptyMs = Date.now() - started;
		assert(
			empty.length === 0 && emptyMs >= 1_800,
			`long poll vazio deveria esperar ~2s (esperou ${emptyMs}ms)`,
		);
		started = Date.now();
		const pending = receive(q.url, { wait: 10 });
		await sleep(500);
		await send(q.url, "wake", "grp-1");
		const woke = await pending;
		const wokeMs = Date.now() - started;
		assert(
			woke.length === 1 && wokeMs < 3_000,
			`long poll deveria acordar com a mensagem (${wokeMs}ms)`,
		);
		const m = woke[0] as Message;
		assert(
			m.Attributes?.ApproximateReceiveCount === "1",
			`ApproximateReceiveCount=${m.Attributes?.ApproximateReceiveCount}`,
		);
		assert(
			m.Attributes?.MessageGroupId === "grp-1",
			`MessageGroupId=${m.Attributes?.MessageGroupId}`,
		);
		return `vazio esperou ${emptyMs}ms; com mensagem acordou em ${wokeMs}ms; atributos ok`;
	},
);

await check(
	"6",
	"ChangeMessageVisibility: 0 devolve na hora; N s adia",
	async () => {
		const q = await createFifo("vis", { VisibilityTimeout: "30" });
		await send(q.url, "v", "g");
		const first = (await receive(q.url))[0] as Message;
		assert(first, "recebimento inicial");
		await sqs.send(
			new ChangeMessageVisibilityCommand({
				QueueUrl: q.url,
				ReceiptHandle: first.ReceiptHandle,
				VisibilityTimeout: 0,
			}),
		);
		const again = await receive(q.url);
		assert(
			again.length === 1 &&
				again[0]?.Attributes?.ApproximateReceiveCount === "2",
			`com 0 deveria voltar na hora (count=${again[0]?.Attributes?.ApproximateReceiveCount})`,
		);
		const second = again[0] as Message;
		await sqs.send(
			new ChangeMessageVisibilityCommand({
				QueueUrl: q.url,
				ReceiptHandle: second.ReceiptHandle,
				VisibilityTimeout: 3,
			}),
		);
		const hidden = await receive(q.url);
		assert(hidden.length === 0, "com 3s não deveria voltar já");
		const t0 = Date.now();
		await eventually(
			async () => ((await receive(q.url)).length > 0 ? true : undefined),
			8_000,
			"reentrega após 3s",
		);
		const elapsed = Date.now() - t0;
		assert(elapsed >= 1_500, `reentrega cedo demais (${elapsed}ms)`);
		return `0 -> imediata; 3s -> reapareceu após ~${elapsed}ms`;
	},
);

await check(
	"7",
	"SendMessageBatch com falha parcial: entrada inválida falha sozinha",
	async () => {
		const q = await createFifo("partial", { VisibilityTimeout: "30" });
		const out = await sqs.send(
			new SendMessageBatchCommand({
				QueueUrl: q.url,
				Entries: [
					{
						Id: "ok1",
						MessageBody: "one",
						MessageGroupId: "g1",
						MessageDeduplicationId: `o1-${run}`,
					},
					{
						Id: "bad",
						MessageBody: "two",
						MessageGroupId: "g".repeat(129),
						MessageDeduplicationId: `o2-${run}`,
					},
					{
						Id: "ok2",
						MessageBody: "three",
						MessageGroupId: "g2",
						MessageDeduplicationId: `o3-${run}`,
					},
				],
			}),
		);
		const ok = (out.Successful ?? []).map((s) => s.Id).sort();
		const failed = (out.Failed ?? []).map(
			(f) => `${f.Id}:${f.Code}:senderFault=${f.SenderFault}`,
		);
		assert(
			ok.join() === "ok1,ok2" &&
				failed.length === 1 &&
				failed[0]?.startsWith("bad:"),
			`Successful=${ok} Failed=${failed}`,
		);
		return `Successful=${ok}; Failed=${failed}`;
	},
);

await check("8", "fila inexistente: código de erro exato", async () => {
	const probe = async (
		label: string,
		fn: () => Promise<unknown>,
	): Promise<string> => {
		try {
			await fn();
			return `${label}: sem erro`;
		} catch (err) {
			const e = err as {
				name?: string;
				Code?: string;
				__type?: string;
				$fault?: string;
				$metadata?: { httpStatusCode?: number };
			};
			return `${label}: name=${e.name} Code=${e.Code} __type=${e.__type} http=${e.$metadata?.httpStatusCode} fault=${e.$fault}`;
		}
	};
	const missing = `${createdUrls[0]?.replace(/\/[^/]+$/, "")}/does-not-exist-${run}.fifo`;
	const results = [
		await probe("GetQueueUrl", () =>
			sqs.send(
				new GetQueueUrlCommand({ QueueName: `does-not-exist-${run}.fifo` }),
			),
		),
		await probe("ReceiveMessage", () =>
			sqs.send(new ReceiveMessageCommand({ QueueUrl: missing })),
		),
		await probe("SendMessage", () =>
			sqs.send(
				new SendMessageCommand({
					QueueUrl: missing,
					MessageBody: "x",
					MessageGroupId: "g",
					MessageDeduplicationId: "d",
				}),
			),
		),
		await probe("GetQueueAttributes", () =>
			sqs.send(
				new GetQueueAttributesCommand({
					QueueUrl: missing,
					AttributeNames: ["All"],
				}),
			),
		),
	];
	assert(
		results.every((r) => !r.endsWith("sem erro")),
		results.join(" | "),
	);
	for (const r of results) note(r);
	return results.join(" | ");
});

await check(
	"9",
	"RAM do emulador (SPIKE_SQS_CONTAINER, padrão wagering-test-sqs-1)",
	async () => {
		const container = process.env.SPIKE_SQS_CONTAINER ?? "wagering-test-sqs-1";
		if (!container) return "n/a (SPIKE_SQS_CONTAINER não definido)";
		const proc = Bun.spawn(
			[
				"docker",
				"stats",
				"--no-stream",
				"--format",
				"{{.MemUsage}}",
				container,
			],
			{ stdout: "pipe" },
		);
		return `${(await new Response(proc.stdout).text()).trim()} (após o spike)`;
	},
);

for (const url of createdUrls)
	await sqs
		.send(new DeleteQueueCommand({ QueueUrl: url }))
		.catch(() => undefined);
finish("spike:sqs");
