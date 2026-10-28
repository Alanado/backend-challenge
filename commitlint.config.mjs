// Conventional Commits com descrição em português. A `config-conventional` aceita acentos;
// nenhuma regra de formato foi desligada. Única adição: a regra local abaixo.
export default {
	extends: ["@commitlint/config-conventional"],
	plugins: [
		{
			rules: {
				// CLAUDE.md / ADR-0001: commits não levam trailer de coautoria nem atribuição à ferramenta.
				"no-co-authored-by": (parsed) => {
					const raw = parsed.raw ?? "";
					const offending =
						/^co-authored-by:/im.test(raw) ||
						/generated with .*claude/im.test(raw);
					return [
						!offending,
						"commit message must not contain Co-Authored-By or tool attribution lines",
					];
				},
			},
		},
	],
	rules: {
		"no-co-authored-by": [2, "always"],
	},
};
