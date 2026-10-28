# Relatório W4 — Adaptadores, invariante e bootstrap

- Data/hora: 2026-10-28 · branch `wave/w4` (a partir da `main` em `a7348fb`, com W1+W2+W3) · HEAD das tarefas: `cee971e`
- Veredito: **VERDE**
- Pré-condições verificadas antes de começar: `typecheck`, `lint`, `test:unit` (358) e `test:integration` (120) verdes; `test:infra:up` ok; migrations 1–3 aplicam (template migrado nas suítes).

## Tarefas

| Tarefa | Commit | Testes que a fecham (ID → arquivo) | Vermelho → verde |
|---|---|---|---|
| T-024 | `bccc1c0` | X-10..X-13 (round-trips, `FOR UPDATE`, versão, `ON CONFLICT`, `wakeDependents`) → `test/integration/repositories.test.ts`; X-20/X-21 (bloqueio, `lock_timeout`, deadlock, `statement_timeout`, conexão morta/recusada, vazamento de pool) → `test/integration/transaction-manager.test.ts`; X-30 (tradução) → `test/unit/platform/persistence-error-translation.test.ts`; X-07 (DI das portas) → `test/integration/infrastructure-module.test.ts`; dá suporte a TST-I-02 (UNIQUE/FK na prática: `wallets_player_currency_uk`, FK órfã) | Repositórios como stubs `not implemented`: os testes de integração falharam por isso (27 vermelhos na primeira rodada). Depois da implementação: 33/33 verdes. O teste de pool (X-21) ficou vermelho (trava na 3ª transação) até o workaround. |
| T-025b | `33ed928` | TST-I-14 (parte da invariante) → `test/integration/ledger-integrity.test.ts` (14 testes) + último teste de `repositories.test.ts` e de `transaction-manager.test.ts` | Reader stub: 14/14 vermelhos (`not implemented`); com o SQL em CTE: 14/14 verdes |
| T-026 | `cee971e` | BOOT-01..06 → `test/integration/bootstrap.test.ts` (28 testes: 16 combinações de flags em processo; pool fechado; processo real com `Bun.spawn`) | Stubs (`AppModule` sem papéis, `main.ts` saindo com 1): 28/28 vermelhos; depois 28/28 verdes |

Notas de método: o tradutor de erros (`persistence-error-translation.ts`) foi escrito antes do seu teste unitário, então esse teste nasceu verde; a prova de dentes abaixo cobre isso. T-024 saiu em **um** commit (grande, mas coeso); não foi preciso propor corte.

## Gate (saída real)

| Comando | Exit | Resumo |
|---|---|---|
| `git status` / `bun install --frozen-lockfile` | 0 | limpo; "Checked 239 installs … (no changes)" |
| `bun run test:infra:up` | 0 | Postgres 5433 + LocalStack 4567 saudáveis; filas `unchanged` ×3 |
| `bun run typecheck` | 0 | sem erros |
| `bun run lint` | 0 | "Checked 123 files … No fixes applied", sem warnings |
| `bun run test:unit` | 0 | 380 pass / 0 fail / 0 skip (3,6 s) |
| `bun run test:integration` ×3 | 0, 0, 0 | 198 pass / 0 fail / 0 skip em cada uma (12,0 s; 13,0 s; 13,1 s) |
| `bun run test:concurrency` | 0 | sem testes até a W7 (passa vazio, como já documentado) |
| `grep -rnE "\.(skip\|todo\|only)\b\|xit\(\|xdescribe\(" test src` | — | nada |
| `grep -rnE "@mikro-orm\|@nestjs" src/shared src/modules/*/domain` | — | nada; TST-U-13 (teste de arquitetura) segue verde |
| Boot manual (`bun src/main.ts` com Postgres de teste, `curl`, `kill -TERM`) | 0 | `{"event":"app_started",…}`, HTTP 404 JSON, `{"event":"app_stopped","signal":"SIGTERM"}`, `exit=0` |

## IDs de teste exigidos × encontrados

`grep -rhoE "TST-[UIC]-[0-9]+" test | sort -u` → TST-I-01, TST-I-02, TST-I-03, TST-I-04, **TST-I-14**, TST-U-01..U-09, **TST-U-13**. Todos os exigidos presentes (TST-U-13 continua; TST-I-14 parte da invariante; TST-I-01..I-04 continuam). Os IDs próprios da onda (`X-*`, `BOOT-*`) seguem a convenção "extras X-*" do arquivo da onda.

`assertLedgerInvariant` (gate 5): chamada em todo arquivo novo que cria wallet (`ledger-integrity`, `repositories`, `transaction-manager`) — no segundo e no terceiro por um teste final que confere todas as wallets criadas pelas builders (`p.created`). `bootstrap.test.ts` não cria wallet.

## Provas de dentes (mutação sem commitar → teste que falhou → restaurado)

| Mutação aplicada | Teste que falhou | Restaurado |
|---|---|---|
| `balanceBefore`/`balanceAfter` trocados no mapper (escrita) | 21 falhas (o `OPENING` viola `le_arithmetic`) | sim |
| `balanceBefore`/`balanceAfter` trocados no mapper (leitura) | X-11 (`updateBalance persists … and appends the ledger entry`) | sim |
| `FOR UPDATE` → `SELECT` simples (remove `lockMode`) | X-20 bloqueio por `lock_timeout`; X-20 deadlock cruzado; teste não nomeado por timeout | sim |
| `version = ?` removido do `UPDATE` de `updateBalance` | X-11 versão velha; X-11 mesma atualização duas vezes | sim |
| `wakeDependents` sem a restrição de `wallet_id` | X-12 `wakeDependents wakes only the informed wallet…` | sim |
| `insertIfAbsent` sem `ON CONFLICT DO NOTHING` | X-12 `insertIfAbsent reports a clash…` | sim |
| Tradução `40P01` → `40P02` | X-30 `40P01 becomes …(deadlock)` e `finds the code on the cause chain` | sim |
| Remove `reclaimDeadConnections()` | X-21 (pool de 2 não sobrevive a 4 kills) e X-20 conexão morta | sim |
| Sinal do `DEBIT` invertido na soma do reader | TST-I-14 (consistente, sinais independentes, leituras concorrentes) + invariante final | sim |
| Reader sem a condição de salto de versão | TST-I-14 `a hole in the versions…` | sim |
| Reader sem `balance_before <> prev_after` | TST-I-14 `chain break the sum cannot see`, `first break when there are several` | sim |
| Reader sem a checagem de cauda (`wallets.version` × último lançamento) | TST-I-14 `wallets.version out of step…` | sim |
| Reader em dois statements (saldo lido antes da soma) | TST-I-14 `repeated reads during concurrent writes…` (3/3 execuções) | sim |
| `ConsumerRoleModule` importado sem a flag | BOOT-01 (várias combinações) | sim |
| `ENABLE_HTTP` ignorado em `main.ts` | BOOT-03 `ENABLE_HTTP=false … without listening` | sim |
| Handler de SIGTERM trocado por `enableShutdownHooks()` | BOOT-04 (ambos): exit 143 | sim |
| `ConfigError` sai com código 0 | BOOT-05 ×2, BOOT-06 | sim |

## Desvios, decisões, dependências adicionadas

1. **Vazamento de slot do pool (decisão do autor).** Com o MikroORM 7.2.5/Kysely, se a conexão morre no meio de `em.transactional`, o `ROLLBACK` falha e o Kysely não devolve o cliente: o pool fica com `total:1, idle:0` para sempre (reproduzido com `em.transactional` puro, sem código nosso). Com `DB_POOL_MAX` transações em voo numa queda, o app nunca mais obtém conexão (afetaria TST-I-20 e o breaker da W9). Perguntei; o autor escolheu o **workaround contido**: `pg-pool-reaper.ts` libera (`release(true)`) clientes `_queryable === false`/`_ending` ainda presos, chamado em `MikroTransactionManager.run` quando o erro é `InfrastructureUnavailableError`. Usa membros privados de `pg`/`pg-pool` (tipos estruturais, guardas estritas, documentado no arquivo). Coberto por X-21. **Remover quando o upstream corrigir.** Sem troca de dependência.
2. **`enableShutdownHooks()` não é usado.** Em Bun, o hook do Nest fecha o app e reenvia o sinal ao processo, que termina com **143**, contradizendo o critério "SIGTERM encerra limpo (exit 0)" da mesma tarefa. `main.ts` instala o próprio handler (`SIGTERM`/`SIGINT` → `app.close()`, mesmos hooks `OnModuleDestroy`/`OnApplicationShutdown`) e deixa o processo terminar sozinho (o que prova que nada ficou vivo). Provado por BOOT-04 e pela mutação que volta ao hook do Nest.
3. **Linhas de boot/stop em stdout** (`app_started` com nomes de papéis e porta; `app_stopped`): mínimo para o smoke ser determinístico, sem valores nem dados sensíveis. O logger estruturado fica para a W5, que as substitui.
4. **Portas como classes abstratas** (servem de token de DI sem `Symbol`); a camada `application` não importa Nest. `infrastructureModule` passou a registrar schemas, `MikroTransactionManager`, repositórios (`useExisting` das portas) e `ActiveRoles`.
5. **Extensões mínimas das portas, além da lista da tarefa:** `WagerTransactionRepository.update(transaction, now)` recebe `now` porque `updated_at` existe na tabela mas não no domínio da W2 (sem alterar o domínio); `InboxRepository.find` e `OutboxRepository.findById` (necessários para os round-trips e para o caminho de dedup); `RowNotFoundError` quando `update`/`markProcessed` não acham a linha; `TransactionRequiredError` quando `FOR UPDATE` é pedido fora de `run`.
6. **SQL cru:** o ORM faz `FOR UPDATE` (`LockMode.PESSIMISTIC_WRITE`), leituras (`disableIdentityMap`) e `em.insert`. `ON CONFLICT DO NOTHING` sem alvo, `UPDATE … WHERE version = ?`, `update` da transação, `wakeDependents`, `existsProcessedReversalOf` e o SQL do reader usam `em.execute` parametrizado (permitido pelo ADR-0002, reportado aqui).
7. **`TransactionManager.run(work: () => Promise<T>)` sem argumento:** a transação viaja por `AsyncLocalStorage`; `run` aninhado entra na transação aberta (sem savepoint). Leituras fora de `run` (fast path HTTP, futuro) não passam pela tradução de erros; as tarefas seguintes usam `run`.
8. **`LedgerIntegrityReader`** devolve `Money` (inclui diferença negativa) e é consumido pela porta `LedgerIntegrityRead` (T-035 depende da porta). Definição de `firstBreakAtVersion`: versão do primeiro lançamento que quebra a cadeia, ou `min(última versão, wallets.version) + 1` quando a cauda não casa (wallet sem lançamentos conta como versão 1).
9. **Script `dev`** (`bun --watch src/main.ts`) adicionado ao `package.json`. O `CLAUDE.md` foi atualizado com autorização expressa do autor (`bun run dev` saiu de "a criar" para os comandos existentes), no commit `a380beb` `docs(claude): atualiza comandos com o script dev (T-026)`, posterior ao relatório; é a única alteração fora das exceções do protocolo.
10. **Dependências novas:** nenhuma. Sem `any`, `@ts-ignore` nem `biome-ignore`. Specs e ADRs intocados; só os três checkboxes de `06-tasks.md`.

## Perguntas em aberto / bloqueios

- Nenhum bloqueio. Pendências para o autor: decidir quando remover o reaper (acompanhar correção no MikroORM/Kysely).

## Pré-condições da próxima onda (W5) verificadas

`bun run typecheck`, `lint`, `test:unit` (380), `test:integration` (198, 3×) verdes; `bun src/main.ts` sobe, responde e encerra com exit 0; repositórios, `TransactionManager`, `LedgerIntegrityReader` e `assertLedgerInvariant` disponíveis; pontos de registro dos papéis prontos para T-040, T-041 e T-043. **CP1 (M0, M1, M2):** fechado por esta onda, a confirmar pelo autor.
