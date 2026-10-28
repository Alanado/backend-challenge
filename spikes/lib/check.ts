// Mini-harness dos spikes: cada item da checklist é uma verificação nomeada.
// O processo sai com código 1 se algum item falhar.
const results: { id: string; ok: boolean; detail: string }[] = [];

export async function check(
	id: string,
	title: string,
	fn: () => Promise<string | undefined>,
): Promise<void> {
	try {
		const detail = (await fn()) ?? "";
		results.push({ id, ok: true, detail });
		console.log(`PASS ${id} ${title}${detail ? ` -> ${detail}` : ""}`);
	} catch (err) {
		const detail = err instanceof Error ? `${err.message}` : String(err);
		results.push({ id, ok: false, detail });
		console.log(`FAIL ${id} ${title} -> ${detail}`);
	}
}

export function note(message: string): void {
	console.log(`INFO ${message}`);
}

export function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`assertion failed: ${message}`);
}

export function finish(name: string): never {
	const failed = results.filter((r) => !r.ok);
	console.log(
		`\n${name}: ${results.length - failed.length}/${results.length} itens ok`,
	);
	process.exit(failed.length === 0 ? 0 : 1);
}
