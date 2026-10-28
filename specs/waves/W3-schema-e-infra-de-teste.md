# W3 — Schema e infra de teste

**Slot:** quarta (trilha A; pode rodar enquanto a W2 termina) · **Branch:** `wave/w3` (a partir da `main` já com a W1 mergeada) · **Depende de:** W1 · **Libera:** W4 (junto com W2) · **Tamanho:** M

## Prompt (cole na sessão)

```text
Você é a sessão executora da Onda W3 — Schema e infra de teste do desafio Distributed Wagering Processor.
Trabalhe dentro do WSL, na pasta do repositório (ou worktree) com a branch wave/w3, criada a partir da main que já contém a W1 mergeada.
Leia nesta ordem: CLAUDE.md, specs/README.md, specs/waves/_common.md e specs/waves/W3-schema-e-infra-de-teste.md. Depois leia somente a seção "Leitura" deste arquivo e specs/adr/0002-spike.md (resultado dos spikes da W1).
Execute APENAS as tarefas desta onda NESTA ORDEM: T-020, T-045, T-025a, T-021, T-022, T-023. Testes primeiro, um commit por tarefa, protocolo de _common.md. Integração com PostgreSQL REAL (Compose de teste), sem mocks do banco.
O schema SQL é o do specs/02-design.md §4: implemente-o exatamente, sem "melhorias". Não altere specs nem ADRs. Em dúvida de decisão, pare e pergunte no formato Problema/Opções/Recomendação/Explicação.
Ao final: rode o gate, escreva specs/waves/reports/W3-report.md e informe o veredito com a evidência.
```

## Leitura

[02-design.md](../02-design.md) §4 (schema e triggers), §7, §8 (config) · [05-test-plan.md](../05-test-plan.md) §2 e §4 (TST-I-01..I-04) · [03-messaging.md](../03-messaging.md) §9 (seam de falha) · [ADR-0006](../adr/0006-concorrencia-lock-pessimista.md) · [ADR-0008](../adr/0008-idempotencia.md) · [ADR-0009](../adr/0009-ledger-imutavel.md) · [ADR-0010](../adr/0010-reversao-unica-por-referencia.md) · [ADR-0019](../adr/0019-estrategia-de-testes.md) · [01-requirements.md](../01-requirements.md) RF-WAL-01/03, RF-LED-*, RF-TXN-01, RF-IDP-04/06, RNF-02 · `adr/0002-spike.md`.

## Pré-condições

- `main` com W1 mergeada: `bun run test:infra:up` funciona; `adr/0002-spike.md` existe; scripts `migration:*` do spike T-002 existem.
- `bun run typecheck && bun run lint && bun run test:unit` verdes.
- W2 **não** precisa estar mergeada (esta onda não usa domínio).

## Tarefas (ordem de execução)

| # | Tarefa | Entrega | Testes que a fecham |
|---|---|---|---|
| 1 | **T-020** | Config Zod do ambiente + módulo de infraestrutura (MikroORM, pool, timeouts) | unit de config + integração do módulo (extras `X-*`) |
| 2 | **T-045** | Seam `TEST_FAULT` + recusa em produção | unit do seam e da config |
| 3 | **T-025a** | Infra de teste: template, `createSuiteDatabase`, filas por suíte, `eventually` | integração dos helpers (extras `X-*`) |
| 4 | **T-021** | Migration 1: `wallets`, `wager_transactions` (constraints, índice parcial, índices) | **TST-I-01** (parcial), **TST-I-02** (parcial) |
| 5 | **T-022** | Migration 2: `wallet_ledger_entries` + triggers de imutabilidade + trigger de `wager_transactions`; `down` seguro | **TST-I-01**, **TST-I-02**, **TST-I-03**, **TST-I-04** |
| 6 | **T-023** | Migration 3: `inbox_messages`, `outbox_messages` | **TST-I-01** (completo, 3 migrations), **TST-I-02** (parcial) |

### Detalhes e armadilhas

**T-020 Config + módulo de infra.** Schema Zod com **todas** as variáveis do [02-design §8](../02-design.md) e seus padrões (flags `ENABLE_*`, `DB_POOL_MAX`, timeouts, backoffs, `SQS_*`, `BREAKER_*`, `SHUTDOWN_GRACE_MS`, `TEST_FAULT`). Acrescente as variáveis de infraestrutura que o §8 não lista mas são óbvias (`DATABASE_URL`, `PORT`, endpoint e região do SQS, credenciais fictícias, nomes/URLs das filas, `NODE_ENV`, `LOG_LEVEL`) e **liste-as no relatório**. `loadConfig(env)` é função pura em `src/shared` (sem `@nestjs/*`), com coerção de números e booleanos vindos de string e mensagem de erro legível (nome da variável + problema). O módulo Nest/MikroORM fica em `src/modules/platform/infrastructure` (conforme o mapa do código): pool com `DB_POOL_MAX`, driver `pg`, e um helper de transação que aplica `SET LOCAL lock_timeout` e `SET LOCAL statement_timeout` com os valores da config. Testes: config (padrões, inválidos, coerção, erro legível); integração real: o módulo conecta, o helper aplica os timeouts **dentro** da transação (`SHOW lock_timeout`) e **não vazam** para fora dela.

**T-045 Seam de falha.** Porta `FaultInjector` (sem Nest) com os três pontos fixos de [03-messaging §9](../03-messaging.md): `crash-after-commit-before-ack`, `crash-after-publish-before-commit`, `fail-mid-transaction`. Nenhum ponto novo. Implementação: lê `TEST_FAULT`; `check(point)` é no-op se não for o ponto configurado; no ponto configurado, `fail-mid-transaction` lança `InjectedFaultError` e os dois `crash-*` chamam uma função de "crash" **injetável** (padrão: derrubar o processo; em testes em processo: lançar `SimulatedCrashError`). **A config recusa `TEST_FAULT` não vazia quando `NODE_ENV=production`** (a aplicação aborta no boot; o teste de boot real vem na T-026). Valor desconhecido é erro de config. Os **ganchos** dentro dos casos de uso ficam com as tarefas dona (fronteira N6): T-031a, T-040, T-041. Aqui só a porta, a config e os testes.

**T-025a Infra de teste.** Em `test/support/`:
- `createSuiteDatabase()`: garante o banco *template* (criado e migrado **uma vez** por execução, protegido por advisory lock se houver corrida), garante que **nenhuma conexão** esteja aberta no template (verifique em `pg_stat_activity` e falhe alto se houver), faz `CREATE DATABASE <suite> TEMPLATE <tmpl>` e devolve conexão/URL; teardown com `DROP DATABASE … WITH (FORCE)`. Funciona mesmo com zero migrations (o template nasce vazio e passa a refletir as migrations conforme elas aparecem).
- `createSuiteQueues(prefix)`: cria, via SDK, fila principal FIFO + DLQ FIFO com redrive + fila de eventos FIFO, com **sufixo aleatório**; teardown deleta.
- `eventually(fn, { timeout, interval })`: polling curto (sem `sleep` fixo), devolve o valor, estoura com mensagem que inclui o último erro.
- Util de ids únicos (UUIDv7 de `Bun.randomUUIDv7()`) para cada teste.
- Testes (reais): dois bancos de suíte são **isolados** (escrita em um não aparece no outro; o template permanece intocado); filas têm sufixos distintos e `RedrivePolicy` correta; `eventually` resolve quando a condição vira verdadeira, estoura no timeout com o último erro, e não usa espera fixa.

**T-021 Migration 1.** Exatamente o SQL de `wallets` e `wager_transactions` do [02-design §4](../02-design.md), incluindo `CHECK`s nomeados, `UNIQUE`s, o índice único parcial `wt_one_reversal_per_reference` e os índices `wt_pending_due` e `wt_pending_by_ref`. `down` reverte. Scripts `migration:up/down` funcionando contra o banco de dev e contra o de suíte. Testes de constraint **por SQL cru**, um por regra: `UNIQUE (player_id, currency)`, `UNIQUE (provider_id, idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)`, `balance >= 0`, `version >= 1`, `amount > 0`, `wt_ref_required`, `wt_ref_forbidden`, `wt_failure_code`, `wt_processed_at`, `wt_pending_ref`, FKs, e o índice parcial (duas reversões `PROCESSED` da mesma referência violam; uma `REJECTED` + uma `PROCESSED` não). Cada teste usa ids únicos; **sem TRUNCATE**.

**T-022 Migration 2.** `wallet_ledger_entries` com `le_arithmetic`, `le_one_per_tx`, `le_version_uk` e checks de saldo; função e triggers `ledger_no_row_change` (UPDATE/DELETE) e `ledger_no_truncate` (TRUNCATE); função `wager_transactions_guard` e trigger `wt_guard`. **`down` seguro:** `DROP TABLE` não dispara triggers de linha, mas qualquer `down` que **apague linhas** precisa desabilitar o trigger antes (`ALTER TABLE … DISABLE TRIGGER …`), e só onde apaga. Testes: constraints do ledger (cada uma); **I-03:** `UPDATE`, `DELETE` e `TRUNCATE` falham, inclusive como dono da tabela/superusuário; **I-04:** linha terminal não admite `UPDATE` nem `DELETE`; qualquer linha não admite `DELETE`; colunas de identidade imutáveis em linha não terminal; as atualizações legítimas de linha não terminal (mudar `status`, `reference_attempts`, `next_attempt_at`, `observed_balance`, `failure_code`, `processed_at`, `updated_at`, `reference_transaction_id`) **passam**; `PENDING_REFERENCE → PROCESSED` passa. **`down`/`up`/`down` com ledger e transações terminais populados** não pode falhar.

**T-023 Migration 3.** `inbox_messages` (PK `(consumer_name, message_id)`) e `outbox_messages` (`ob_final_exclusive`, índice parcial `ob_publishable`). Testes: PK do inbox impede duplicata; `ob_final_exclusive` impede `published_at` e `failed_at` juntos; round-trip `up → down → up` das **três** migrations em sequência, também com dados.

## Gate

| # | Verificação | Esperado |
|---|---|---|
| 1 | `bun install --frozen-lockfile` · `typecheck` · `lint` | limpos |
| 2 | `bun run test:infra:up` (Postgres e SQS reais) | ok |
| 3 | `bun run test:unit` e `bun run test:integration` (3×) | verdes, 0 skip |
| 4 | IDs exigidos | **TST-I-01, I-02, I-03, I-04** |
| 5 | Manual: `bun run migration:up` → `migration:down` (×3) → `migration:up` no banco de dev | ok, schema final idêntico ao do §4 |
| 6 | Isolamento | rodar dois processos de teste em sequência: os bancos de suíte não colidem e são removidos ao final (conferir `pg_database`) |
| 7 | Teste de boot da config | `TEST_FAULT=crash-after-commit-before-ack NODE_ENV=production` é recusado |

**Provas de dentes:** remover o trigger do ledger → I-03; remover o `CHECK (balance >= 0)` → I-02; remover o índice parcial de reversão → I-02; remover o `IF OLD.status IN (…)` do guard → I-04; fazer o helper reutilizar sempre o mesmo banco → o teste de isolamento; colocar um `DELETE FROM wallet_ledger_entries` no `down` sem desabilitar o trigger → I-01; remover a recusa em produção → o teste de config.

## Pare e pergunte se

O SQL do §4 não rodar como escrito no Postgres fixado; o migrator do MikroORM não suportar o necessário (ex.: `CREATE TRIGGER` multi-statement); `CREATE DATABASE … TEMPLATE` for bloqueado no ambiente; alguma tarefa pedir mais de um commit.

## Fora do escopo

EntitySchemas, mappers, repositórios, `assertLedgerInvariant` (T-025b), bootstrap (T-026), logs/métricas.

## Entregáveis

6 commits + relatório · migrations 1–3 · helpers de teste · `FaultInjector` · config. **Mergear na `main`** antes da W4.
