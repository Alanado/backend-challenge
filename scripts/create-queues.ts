import {
	CreateQueueCommand,
	GetQueueAttributesCommand,
	GetQueueUrlCommand,
	QueueDoesNotExist,
	SetQueueAttributesCommand,
	SQSClient,
} from "@aws-sdk/client-sqs";

// Cria (ou confere) as filas de 02-design §9. Idempotente: filas iguais ao desejado ficam "unchanged".
// SQS_ENDPOINT (padrão http://localhost:4566, o do docker-compose.yml de desenvolvimento).
const endpoint = process.env.SQS_ENDPOINT ?? "http://localhost:4566";
const sqs = new SQSClient({
	region: process.env.AWS_REGION ?? "us-east-1",
	endpoint,
	credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

const MAIN = "wager-transactions.fifo";
const DLQ = "wager-transactions-dlq.fifo";
const EVENTS = "wager-events.fifo";
const MAX_RECEIVE_COUNT = 8;

async function queueUrl(name: string): Promise<string | undefined> {
	try {
		return (await sqs.send(new GetQueueUrlCommand({ QueueName: name })))
			.QueueUrl;
	} catch (err) {
		if (err instanceof QueueDoesNotExist) return undefined;
		throw err;
	}
}

// Converge a fila para os atributos desejados e informa created | updated | unchanged.
async function ensureQueue(
	name: string,
	desired: Record<string, string>,
): Promise<{ url: string; arn: string }> {
	let url = await queueUrl(name);
	let status: "created" | "updated" | "unchanged" = "unchanged";
	if (!url) {
		const created = await sqs.send(
			new CreateQueueCommand({
				QueueName: name,
				Attributes: { FifoQueue: "true", ...desired },
			}),
		);
		url = created.QueueUrl;
		status = "created";
	}
	if (!url) throw new Error(`queue ${name} has no url`);

	const current =
		(
			await sqs.send(
				new GetQueueAttributesCommand({
					QueueUrl: url,
					AttributeNames: ["All"],
				}),
			)
		).Attributes ?? {};
	const differs = Object.entries(desired).filter(
		([key, value]) => normalize(key, current[key]) !== normalize(key, value),
	);
	if (differs.length > 0) {
		await sqs.send(
			new SetQueueAttributesCommand({
				QueueUrl: url,
				Attributes: Object.fromEntries(differs),
			}),
		);
		status = status === "created" ? "created" : "updated";
	}
	const arn = current.QueueArn;
	if (!arn) throw new Error(`queue ${name} has no arn`);
	console.log(`${status.padEnd(9)} ${name}`);
	return { url, arn };
}

// RedrivePolicy é JSON: compara estruturalmente, não por texto.
function normalize(key: string, value: string | undefined): string {
	if (value === undefined) return "";
	return key === "RedrivePolicy"
		? JSON.stringify(sortKeys(JSON.parse(value)))
		: value;
}

function sortKeys(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => [k, k === "maxReceiveCount" ? Number(v) : v]),
	);
}

const dlq = await ensureQueue(DLQ, {});
await ensureQueue(MAIN, {
	VisibilityTimeout: "30",
	ReceiveMessageWaitTimeSeconds: "20",
	RedrivePolicy: JSON.stringify({
		deadLetterTargetArn: dlq.arn,
		maxReceiveCount: MAX_RECEIVE_COUNT,
	}),
});
await ensureQueue(EVENTS, {});
