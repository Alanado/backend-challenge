# Relatório WS-01 — `bun run test:load` (stretch S-01)
- Data/hora: 2026-10-29, tarde (-03) · branch `wave/ws-01` (já existia em `c677484`, sem commits próprios; avançada por fast-forward para a `main` `c40b552` antes de começar) · HEAD das tarefas: `bc2fb61`
- Veredito: **VERDE** (com um desvio de orçamento de tempo da suíte, abaixo). Merge na `main` é do autor.

## Passo 0
Decisões L-1 a L-7 apresentadas no formato Problema/Opções/Recomendação/Explicação e aprovadas pelo autor nas recomendações ("Ok, prossiga"), antes de qualquer código. ADR-0021 registrado em `c135592`. Uma segunda decisão foi levada ao autor durante a onda (ECONNRESET, ver Desvios) e aprovada (retry 1× com a mesma chave).

## Tarefas
| Tarefa | Commit | Testes que a fecham (ID → arquivo) | Vermelho → verde |
|---|---|---|---|
| ADR-0021 | `c135592` | n/a (documentação) | n/a |
| S-01a | `ec21d07` | TST-U-15 → `test/unit/load/measurement.test.ts` | stubs: 2 pass / 18 fail → 20 pass |
| S-01b | `aa88ab2` | TST-I-22 → `test/integration/load-smoke.test.ts` | saída ≠ 0 (script inexistente) → 1 pass |
| S-01b (correção) | `53ae778` | TST-U-15 (+1 teste: reset recuperado) | → 21 pass |
| S-01c | `a57827f` | TST-I-23 → `test/integration/load-strategies.test.ts` | 2 fail (wallet sem lançamento de abertura; `$1` com tipos inconsistentes) → 2 pass |
| S-01d | `bc2fb61` | `check-readme-commands` (14 comandos), `check-architecture`, `check-traceability` | exit 0 |

## Gate (saída real)
| Comando | Exit | Resumo |
|---|---|---|
| `git diff main -- src` | — | vazio (0 linhas) |
| `bun install --frozen-lockfile` | 0 | 253 instalações, sem mudanças |
| `typecheck` / `lint` | 0 / 0 | sem erros |
| `bun run test` ×3 (unit + integration + concurrency) | 0, 0, 0 | unit 546 pass / 0 fail; integration 479 pass / 0 fail; concurrency 21 pass / 0 fail; total 3 min 5 s, 2 min 55 s, 2 min 54 s |
| `bun run test:load` ×3 (perfil full, do zero) | 0, 0, 0 | 277 wallets verificadas em cada; números em [LOAD-REPORT.md](../../../LOAD-REPORT.md) |
| `check-readme-commands` / `check-architecture` / `check-traceability` | 0 / 0 / 0 | ok |
| varredura de skips | — | 3 ocorrências, todas falsos positivos do padrão (`process.exit(` casa `xit(`) em `test/load/run.ts`; nenhum `skip/todo/only` |

Linha de base da W12: unit 525, integration 476 (121–125 s), concurrency 21. Agora: +21 unit, +3 integration.

## IDs de teste exigidos × encontrados
`TST-U-15`, `TST-I-22`, `TST-I-23`: os três encontrados em `test/`.

## Provas de dentes
| Mutação aplicada (sem commitar) | Teste que falhou | Restaurado |
|---|---|---|
| Percentil devolve a média | TST-U-15: 4 fail (16 pass) | sim |
| Gerador envia `amount` com 3 casas (`"1.005"`) | `test:load`: 7.564 respostas `400` inesperadas, erro 100 %, saída 1, `ledger invariant: VIOLATED` | sim |
| `UPDATE wallets SET balance = balance + 1` no fim da carga | passo de verificação final: `stored balance 999963.00 != ledger sum 999962.00`, saída 1 | sim |
| Remover o `FOR UPDATE` da variante A (microbenchmark) | TST-I-23 (A): aceitas 22 em vez de 180 | sim |

## Desvios, decisões, dependências adicionadas
- **Dependências novas:** nenhuma.
- **`ECONNRESET` raro (decisão do autor):** em 3 de 6 execuções `full` iniciais houve 1 reset de conexão em ~8.000 requisições, e o comando saía 1. Levado ao autor; aprovado reenviar uma vez com a mesma `Idempotency-Key`, contar à parte e reportar. Nota acrescentada ao item 5 do ADR-0021. As 3 execuções finais não tiveram nenhum reset (contador 0). Causa não provada; `src/` não mudou.
- **Orçamento de tempo da suíte: estourado.** O planejamento pedia no máximo +15 s. A suíte de integração foi de 121–125 s (W12) para 138–147 s: **+17 a +26 s**. Medido por arquivo: TST-I-22 ≈ 14–17 s (14–25 s em execuções soltas, com ruído do WSL), TST-I-23 ≈ 2,6 s. Não alterei nada por conta própria; opção para o autor: tirar o smoke da suíte e deixá-lo só em `test:load -- --profile smoke`, o que contraria o TST-I-22 como teste de integração.
- **`CLAUDE.md`:** atualizada a linha de comandos (`test:load` deixou de ser "a criar"). Não é spec nem ADR; informo por transparência.
- **ADR-0021 recebeu uma emenda** (ECONNRESET) além do texto original, com aprovação do autor.
- **Marcação em `06-tasks.md`:** S-01a, b, c, d e o item S-01 em `[x]`.
- **Achados do experimento** (detalhados no LOAD-REPORT): outbox lag chegando a ~30 s sob ~300 tx/s (causa não isolada); `idempotent_requests_total` do N3 maior que o número de `200` observados (não investigado, não usado como evidência); A × C em SQL isolado: C ≈ 31 % mais vazão, p95/p99 ≈ metade.
- Execuções `full` descartadas (as 3 com reset antes da correção, mais 3 anteriores ao ajuste de log) e execuções `smoke` de verificação não entram nos números; ficaram em `test/load/results/discarded/` (ignorado pelo git).
- Se o WSL tivesse sido suspenso durante uma medição, a execução seria descartada; não houve suspensão observada.

## Perguntas em aberto / bloqueios
- O estouro de +17 a +26 s no tempo da suíte de integração precisa de decisão do autor (aceitar ou tirar o smoke da suíte).
- O merge na `main` é do autor; a branch está verde e antes do limite de 22:00.

## Pré-condições da próxima onda verificadas
Não há onda seguinte planejada (S-02 a S-06 ficam como evolução documentada). `git status` limpo no HEAD das tarefas; `src/` idêntico à `main`.
