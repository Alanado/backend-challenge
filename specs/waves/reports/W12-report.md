# Relatório W12 — Estabilização dos testes e fechamento de interpretação
- Data/hora: 2026-10-29 14:22 (-03) · branch `wave/12` (o prompt dizia `wave/w12`; a branch existente já se chamava `wave/12`) · HEAD das tarefas: `f4f0848`
- Veredito: **VERDE**

## Tarefas
| Tarefa | Commit | Testes que a fecham (ID → arquivo) | Vermelho → verde |
|---|---|---|---|
| T-070 | `58d957f` | TST-U-14 → `test/unit/tooling/test-timeout.test.ts` | 2 fail (`test:integration` e `test:concurrency` sem `--timeout`) → 3 pass após `--timeout 30000` nos dois scripts |
| T-071 | `cc3f588` | TST-I-21 → `test/integration/reversal-reference-cross.test.ts` | já verde de primeira (comportamento real = esperado; sem divergência); vermelho só na prova de dentes |
| T-072 | `f4f0848` | `check-architecture` + `check-traceability` | conferidores exit 0, `specs/traceability.md` regenerado (no commit da T-071 e da T-072) |

Mecanismo do timeout: `[test] timeout` no `bunfig.toml` **não vale** no Bun 1.4.4 (arquivo descartável que dorme 6 s: estourou 5 s com e sem bunfig; passou com `--timeout 30000`). Foi usado `--timeout 30000` nos scripts `test:integration` e `test:concurrency`. `test:unit` não precisou. Os timeouts explícitos da W11 (20 s e 30 s) foram mantidos.

## Gate (saída real)
| Comando | Exit | Resumo |
|---|---|---|
| `bun install --frozen-lockfile` | 0 | ok |
| `typecheck` / `lint` | 0 / 0 | sem erros |
| `test:unit` ×3 | 0,0,0 | 525 pass / 0 fail (≈4 s) |
| `test:integration` ×3 | 0,0,0 | 476 pass / 0 fail (125 s, 122 s, 121 s) |
| `test:concurrency` ×3 | 0,0,0 | 21 pass / 0 fail (34 s, 32 s, 32 s) |
| `health.test.ts` ×6 | 0 | 8 pass / 0 fail em cada |
| `sqs-consumer-inbox.test.ts` ×6 | 0 | 9 pass / 0 fail em cada |
| `check-readme-commands` / `check-architecture` / `check-traceability` | 0 / 0 / 0 | ok; `git status` limpo depois |
| `git diff main -- src` | — | vazio (0 linhas) |
| varredura de skips (`skip/todo/only/xit/xdescribe`) | — | 0 ocorrências |

As suítes foram rodadas uma a uma (sem `&&`) e todas registradas. Linha de base antes de mexer: integração 472 pass / 0 fail.

## IDs de teste exigidos × encontrados
`TST-U-14` e `TST-I-21` presentes (grep). 47 IDs distintos em `test/`; `check-traceability` sem ausentes. Tarefas abertas em `06-tasks.md`: só as do stretch (S-01…S-06); T-070–T-072 em `[x]`.

## Provas de dentes
| Mutação aplicada (sem commitar) | Teste que falhou | Restaurado |
|---|---|---|
| `--timeout` removido dos scripts (`git stash` do `package.json`) | TST-U-14 (2 fail: integration e concurrency) | sim |
| `if (reference.alreadyReversed)` → `if (false && …)` em `transaction-policy.ts` | TST-I-21: 3 fail (WIN, LOSS e replay); o controle continuou verde, como deve | sim (`git checkout -- src`) |
| "Máquina lenta": `health` + `sqs-consumer-inbox` com `--timeout 5000` e 16 processos `yes` (2×nproc=8), depois com `taskset -c 0` e 4 `yes` no mesmo núcleo | **nada falhou** (17 pass nos dois timeouts, nos dois cenários) | n/a |

A falha por margem de tempo **não reproduziu** sob CPU saturada. A relação causal entre o timeout e as falhas da W11 segue inferida, não provada. A prova obrigatória (U-14 vermelho → verde e configuração removida → falha) está feita.

## Desvios, decisões, dependências adicionadas
- Nenhuma dependência nova. `src/` intocado.
- Para registrar `TST-U-14` foi acrescentada uma linha no `05-test-plan.md` §2 (referenciando `RNF-01`, como a tarefa); o `TST-I-21` foi acrescentado ao §4 e citado em RF-TXN-11 e RF-TXN-13 de `01-requirements.md` (aditivo, autorizado pelo plano da onda).
- `TST-I-21` cobre o nível do caso de uso com PostgreSQL real. O mapeamento `REJECTED` → HTTP 422 já é coberto genericamente pelo `TST-I-06`; não foi duplicado um teste HTTP para esse cruzamento.
- Incidente de processo: o primeiro commit da T-070 saiu com um erro de formatação do Biome (mascarado por `| tail`); foi corrigido com `bun run format` e o commit foi emendado (`--amend`, local, nunca publicado) antes de qualquer outra coisa. O lint final está verde.
- `ARCHITECTURE.md`: §10 agora lista a interpretação 10 ("As dez adotadas"); §14 troca "aguarda confirmação" pelo registro da confirmação de 2026-10-29 e ganhou uma linha sobre o timeout global. `01-requirements.md` §12 ganhou a interpretação 10. Nenhum ADR alterado.
- `TST-C-07` não falhou em nenhuma das 3 execuções (sem suspensão do WSL; `uptime` 22 h, `date` coerente).

## Perguntas em aberto / bloqueios
Nenhuma. O comportamento de `WIN`/`LOSS` com referência já revertida confere com o descrito na T-071.

## Pré-condições da próxima onda (WS-01) verificadas
Infra de teste no ar; `main`-base com W0–W11 + W12 na branch `wave/12`; `test:load` continua inexistente (cabe ao stretch).
