# Relatório W10 — Multi-instância e ciclo de vida
- Data/hora: 2026-10-28 · branch `wave/w10` · HEAD das tarefas: `b3b3d6e` (o relatório é o commit seguinte)
- **Veredito: VERDE** (suíte completa 3× verde, 0 skip; Compose do zero saudável 2×; smoke exit 0; 7 provas de dentes feitas). Um acréscimo de configuração (`SHUTDOWN_DRAIN_DELAY_MS`) foi aprovado pelo autor durante a onda (ver Desvios).

## Tarefas
| Tarefa | Commit | Testes que a fecham (ID → arquivo) | Vermelho → verde |
|---|---|---|---|
| T-052 health | `672831c` | TST-I-16, TST-I-17 → `test/integration/health.test.ts` (8 testes, Nest em processo, Postgres e SQS reais, proxy TCP) | 7 de 8 falharam com 404 (rotas inexistentes; o 8º, I-17 de métricas, já passava) → 8 verdes |
| T-046 multi-processo | `64d8c41` | C-04 → `multi-instance-load`; C-05 → `multi-instance-consumer-crash`; C-06 (b) → `multi-instance-publisher-crash`; C-08 → `multi-instance-restart`; C-10 → `multi-instance-mixed-load` (todos em `test/concurrency`); helper `test/support/spawnApp.ts` + `multi-instance.ts` | Testes de comportamento já existente: nasceram verdes; a prova de que mordem são as mutações abaixo (todas vermelhas) |
| T-053 shutdown | `78d0f60` | TST-I-18 → `test/integration/shutdown.test.ts` (processo real, 2 cenários) e `sqs-consumer-shutdown.test.ts` (poller, SQS real); config → `test/unit/shared/config.test.ts` | config: 2 falhas (`undefined`); poller: stop sem grace; processo: `refused` (sem janela de readiness) e 3 mensagens ainda em voo após a saída → 4 verdes |
| T-005b Docker | `b3b3d6e` | `docker compose up --build` do zero + `bun run compose:smoke` (`scripts/compose-smoke.ts`) | n/a (sem teste automatizado; evidência abaixo) |

Nota de histórico: dois commits `chore(test)` (renomeação de `waitExit`) foram dobrados nos commits das T-046 e T-053 por rebase local da branch ainda não mergeada, para manter um commit por tarefa.

## Gate (saída real)
| Comando | Exit | Resumo |
|---|---|---|
| `git status` · `bun install --frozen-lockfile` | 0 | limpo; "253 installs across 281 packages (no changes)" |
| `bun run typecheck` · `bun run lint` | 0 | sem erros nem warnings (228 arquivos) |
| `bun run test` (3 execuções) | 0 ×3 | cada uma: unit 486 pass / 0 fail; integration 472 pass / 0 fail; concurrency 21 pass / 0 fail; tempos totais 166 s, 176 s, 174 s |
| `grep -rnE "\.(skip|todo|only)\b|xit\(|xdescribe\(" test src` | vazio | 0 skip |
| `docker compose down -v && docker compose up --build -d --wait` (2×) | 0 | postgres, sqs, app1..3 `healthy`; `migrate` `Exited (0)`; primeira vez 32 s |
| `bun run compose:smoke` (2×) | 0 | `ready` ×3, wallet 201, BET 201 PROCESSED em cada instância, saldo `70.00` lido nas três, ledger versões `[4,3,2,1]`, reconciliação `consistent: true`, `checkedEntries: 4`, `smoke ok` |
| Deadlocks | — | ver abaixo |

**Deadlocks (gate 7).** Cada teste de C-04/C-10 confere `pg_stat_database.deadlocks` do próprio banco (sem aumento) e `lock_conflicts_total{type=deadlock}` = 0 em cada instância. Como os bancos das suítes são apagados, contei também `deadlock detected` no log do Postgres de teste (container novo, 0 antes): **3 linhas em 3 execuções, 1 por execução**, todas duas conexões travando carteiras em ordem oposta num intervalo de ≈1,2 s; é o teste `X-20` (`transaction-manager.test.ts`), que cruza `FOR UPDATE` de propósito para provar a tradução de `40P01`. Não consegui anexar o nome do teste ao log do servidor; a atribuição se apoia em: exatamente uma ocorrência por execução, o formato (duas carteiras, `limit 1 for update`) e nenhum dos testes de concorrência ter visto deadlock. No Compose, após o smoke e uma rajada de 4 500 requisições: `deadlocks=0`.

## IDs de teste exigidos × encontrados
TST-I-16, TST-I-17, TST-I-18, TST-C-04, TST-C-05, TST-C-06 (b), TST-C-08, TST-C-10: todos presentes (`grep -rhoE "TST-[UIC]-[0-9]+" test`), cada um no título de testes que passam.

## Provas de dentes
| # | Mutação aplicada (sem commitar) | Teste que falhou | Restaurado |
|---|---|---|---|
| 1 | consumidor apaga a mensagem antes de chamar o handler | C-05 (mensagem não volta; esperado 1 recebido 0) | sim |
| 2 | inbox desligado (`channel === "sqs" && Date.now() < 0`) | C-05 (linha de inbox ausente: esperado 1, recebido 0) | sim |
| 3 | publisher marca como publicado e commita antes de enviar | C-06 (b) (esperado 25 linhas não publicadas, recebido 15) | sim |
| 4 | `findByIdForUpdate` da wallet sem `lockMode` | C-04 (resposta fora de 200/201: 500) e C-10 (estado final divergente) | sim |
| 5 | idempotência só em memória (chave e id externo únicos no banco, replay por `Map` do processo) | C-08 (esperado 200, recebido 201 após o restart) | sim |
| 6a | `stop()` não devolve mensagens após o grace | I-18 (poller e processo: 3 mensagens ainda em voo) | sim |
| 6b | `SIGTERM` não marca `draining` | I-18 (readiness 200 em vez de 503) | sim |
| 6c | `stop()` não espera os handlers | I-18 (poller: `stop()` resolveu antes do handler) | sim |
| 7 | `ready` ignora `draining` e breaker aberto | I-16 (breaker e draining, 2 testes) | sim |

Após cada mutação, `git status` sem alterações fora do índice. Incidente: uma restauração com `git checkout` descartou, uma vez, a implementação da T-053 ainda não commitada; reaplicada e posta no índice antes de repetir as mutações, sem efeito no resultado.

## Elimináveis do README §14 (rascunho para a W11)
| Eliminatória | Evidência |
|---|---|
| `number` para dinheiro | `Money` só nasce de string validada (TST-U-01/U-02: rejeita `1e3`, NaN, sem conversão para `number`); coluna `numeric(19,2)` lida como string (spike T-002 item 6); testes usam strings |
| Saldo negativo por race | TST-C-02, C-12, `CHECK` no banco (TST-I-02), `assertLedgerInvariant` no fim de C-04/C-10 com 3 processos; prova de dentes #4 |
| Débito/crédito duplicado | TST-C-01, C-04 (240 HTTP + 120 SQS, 120 efeitos, soma das métricas = 120), C-05, C-08; UNIQUE de idempotência/ledger |
| Idempotência apenas em memória | TST-C-08 (SIGKILL + novo processo → 200 `idempotentReplay`); prova #5 |
| Correta somente com uma instância | TST-C-04, C-05, C-06 (b), C-08, C-10 com processos reais; nenhuma 5xx, zero deadlock |
| Evento publicado antes do commit | outbox na mesma transação (TST-I-05, I-13), C-06 (b) com morte entre envio e commit; prova #3 |
| Ausência de ledger auditável | ledger append-only por trigger (TST-I-03), reconciliação (TST-I-14), invariante em todos os testes |
| Testes que substituem PostgreSQL e SQS por mocks | `grep -rniE "mock\(|jest\.|spyOn|mock\.module" test` vazio; integração/concorrência usam o Compose de teste, processos `Bun.spawn` e proxy TCP sobre o Postgres real |

## RAM (R-06, gate 6)
Medido e anexado em `specs/adr/0002-spike.md` (T-005b): Compose completo ≈ 453 MiB ocioso, ≈ 695 MiB em rajada, ≈ 784 MiB após 9 000 requisições (de 7,75 GiB); suíte de concorrência (3 processos Bun + infra de teste): pico de `used` do WSL 4926 MiB (+613 MiB sobre os 4313 MiB iniciais), RSS dos processos `bun` ≤ 610 MiB. Cabe em 8 GB.

## Desvios, decisões, dependências adicionadas
- **`SHUTDOWN_DRAIN_DELAY_MS` (nova variável, padrão 0).** Problema: no `SIGTERM` o listener HTTP fecha na hora e o 503 de readiness fica invisível (conexão nova recebe `ECONNREFUSED`). Perguntei ao autor, que escolheu a variável. Padrão 0 mantém o comportamento da spec; o Compose usa 2000 ms, os testes 1500 ms. Não está em `02-design §8` nem em ADR: **W11 deve documentá-la** (também em `.env.example`, já atualizado).
- **`waitExit()` virou a propriedade `exited`** no helper: o grep de skips do protocolo (`xit\(`) casa com `waitExit(`.
- Quem roda as migrations: serviço `migrate` de uma execução só (`service_completed_successfully`); detalhes em `adr/0002-spike.md`. Não afeta a spec.
- Estado `LifecycleState` e `ReadinessRegistry` (cada papel registra suas checagens de readiness; fila de entrada e breaker pelo consumidor, fila de eventos pelo publisher): decisão de implementação, sem ADR.
- `SqsMessageConsumer.shutdownGraceMs`: após o grace, handlers que seguem rodando têm a mensagem devolvida (visibilidade 0) e o resultado tardio é ignorado; o handler continua até o pool fechar, limitado por `LOCK_TIMEOUT_MS` (a saída com 0 observada no teste de grace curto levou o lock timeout de 3 s).
- C-06 (b): a deduplicação FIFO do SQS (`MessageDeduplicationId = eventId`, janela de 5 min) absorve o reenvio dos 10 eventos já enviados pelo publisher morto; por isso o consumidor de teste não viu duplicata. O teste prova `eventId` idêntico, linhas não publicadas após a morte e chegada de todos os 25.
- Dependências novas: nenhuma. Imagem `oven/bun:1.4.4-slim` fixada por tag e digest. `package.json`: script `compose:smoke`.
- Mensagem do emulador entre processos: nenhuma diferença de comportamento observada.
- Não atualizei o `CLAUDE.md` (fora das tarefas): na W11, trocar "a criar" de `docker compose up --build` e incluir `compose:smoke`.

## Perguntas em aberto / bloqueios
Nenhum. Atribuição das 3 linhas de deadlock ao X-20 é inferência (ver acima).

## Pré-condições da próxima onda verificadas
W11 (docs e hardening): código congelado (CP4) neste HEAD; `typecheck`, `lint`, unit, integração e concorrência verdes 3×; `docker compose up --build` e `compose:smoke` funcionam do zero.
