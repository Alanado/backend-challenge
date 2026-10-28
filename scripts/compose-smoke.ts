// Smoke do Compose completo (T-005b): uma wallet, um BET por CADA uma das três instâncias, e a
// conferência de saldo, ledger e reconciliação. Sai com 0 quando tudo confere, 1 no primeiro desvio.
// SMOKE_BASES = lista separada por vírgula (padrão: as portas 3001-3003 do docker-compose.yml).
const bases = (
	process.env.SMOKE_BASES ??
	"http://localhost:3001,http://localhost:3002,http://localhost:3003"
).split(",");

const failures: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}${detail === "" ? "" : ` (${detail})`}`,
	);
	if (!ok) failures.push(name);
}

async function call<T = Record<string, unknown>>(
	base: string,
	method: string,
	path: string,
	options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Partial<T> | null }> {
	const response = await fetch(`${base}${path}`, {
		method,
		headers: {
			...(options.body === undefined
				? {}
				: { "Content-Type": "application/json" }),
			...options.headers,
		},
		...(options.body === undefined
			? {}
			: { body: JSON.stringify(options.body) }),
	});
	const text = await response.text();
	return {
		status: response.status,
		body: text === "" ? null : JSON.parse(text),
	};
}

async function waitReady(base: string): Promise<boolean> {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(`${base}/health/ready`)).status === 200) return true;
		} catch {
			// not up yet
		}
		await Bun.sleep(500);
	}
	return false;
}

const BET = "10.00";
const OPENING = "100.00";

async function main(): Promise<void> {
	for (const base of bases) check(`ready ${base}`, await waitReady(base));
	if (failures.length > 0) return;

	const playerId = crypto.randomUUID();
	const created = await call<{ id: string }>(
		bases[0] as string,
		"POST",
		"/wallets",
		{
			body: { playerId, initialBalance: { amount: OPENING, currency: "BRL" } },
		},
	);
	check(
		"wallet created (201)",
		created.status === 201,
		`status ${created.status}`,
	);
	const walletId = created.body?.id ?? "";

	for (const [index, base] of bases.entries()) {
		const externalTransactionId = `smoke-${crypto.randomUUID()}`;
		const reply = await call<{ status: string }>(
			base,
			"POST",
			"/wagering/transactions",
			{
				headers: {
					"Idempotency-Key": `provider-smoke:${externalTransactionId}`,
				},
				body: {
					providerId: "provider-smoke",
					externalTransactionId,
					playerId,
					walletId,
					roundId: "round-smoke",
					gameId: "game-smoke",
					kind: "BET",
					money: { amount: BET, currency: "BRL" },
				},
			},
		);
		check(
			`BET through instance ${index + 1} (201 PROCESSED)`,
			reply.status === 201 && reply.body?.status === "PROCESSED",
			`status ${reply.status}`,
		);
	}

	// Each instance sees the same balance: 100.00 - 3 x 10.00.
	for (const [index, base] of bases.entries()) {
		const wallet = await call<{ balance: { amount: string } }>(
			base,
			"GET",
			`/wallets/${walletId}`,
		);
		check(
			`balance read from instance ${index + 1} is 70.00`,
			wallet.body?.balance?.amount === "70.00",
			`got ${wallet.body?.balance?.amount}`,
		);
	}

	const ledger = await call(
		bases[1] as string,
		"GET",
		`/wallets/${walletId}/ledger`,
	);
	const versions = (ledger.body?.items ?? []).map((item) => item.walletVersion);
	check(
		"ledger has the opening entry and three BETs, newest first",
		versions.length === 4 &&
			versions.every((v, i) => i === 0 || (versions[i - 1] ?? 0) > v),
		`versions ${JSON.stringify(versions)}`,
	);

	const reconciliation = await call<{
		consistent: boolean;
		checkedEntries: number;
	}>(bases[2] as string, "POST", `/wallets/${walletId}/reconciliation`);
	check(
		"reconciliation is consistent",
		reconciliation.status === 200 &&
			reconciliation.body?.consistent === true &&
			reconciliation.body?.checkedEntries === 4,
		JSON.stringify(reconciliation.body),
	);
}

await main();
if (failures.length > 0) {
	console.error(`smoke FAILED: ${failures.join("; ")}`);
	process.exit(1);
}
console.log("smoke ok");
