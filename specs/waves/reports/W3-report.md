# Relatório W3 — Schema e infra de teste
- 2026-10-28 · branch `wave/w3` · HEAD `6494d93` (+ este relatório)
- Veredito: **VERDE**

## Tarefas
| Tarefa | Commit | Testes que a fecham (ID → arquivo) | Vermelho → verde |
|---|---|---|---|
| T-020 | `7c328a7` | CFG-01..09 → `test/unit/shared/config.test.ts`; X-01..06 → `test/integration/infrastructure-module.test.ts` | módulo inexistente (import falhou) → 17 unit + 6 integração verdes. Pool: `pool.pool.max` não existe no driver (Kysely); o teste passou a contar backends distintos sob 20 consultas paralelas |
| T-045 | `7537e19` | FLT-01..08, CFG-TF-01..05 → `test/unit/shared/fault-injector.test.ts` | módulo inexistente → verde; FLT-07 prova o crash real (processo filho sai com 137) |
| T-025a | `2199e38` | X-10..19, X-26 → `test/integration/test-support.test.ts`; X-20..25 → `test/unit/support/eventually.test.ts` | módulos inexistentes → 17 verdes |
| T-021 | `067547e` | TST-I-01, TST-I-02 (parcial) → `test/integration/schema-constraints.test.ts`, `migrations.test.ts` | 16 de 18 falhando (tabelas ausentes) → 34 verdes |
| T-022 | `ab32d1c` | TST-I-01, I-02, I-03, I-04 → `ledger-constraints.test.ts`, `wager-transactions-guard.test.ts`, `migrations.test.ts` | falhas "expected the statement to fail, but it succeeded" (sem triggers) → 105 verdes + 1 ajuste de teste (ver Desvios) |
| T-023 | `6494d93` | TST-I-01 (3 migrations), I-02 (parcial) → `messaging-schema.test.ts`, `migrations.test.ts` | 14 falhando (tabelas ausentes) → 478 verdes no total |

## Gate (saída real)
| Comando | Exit | Resumo |
|---|---|---|
| `git status` · `bun install --frozen-lockfile` | 0 | limpo; "no changes" |
| `bun run typecheck` · `bun run lint` | 0 | sem erros nem warnings (79 arquivos) |
| `bun run test:infra:down && test:infra:up` | 0 | Postgres 17.6 e LocalStack 4.14.0 healthy; 3 filas criadas |
| `bun run test:unit` ×3 | 0 | 358 pass / 0 fail / 0 skip (≈4 s) |
| `bun run test:integration` ×3 | 0 | 120 pass / 0 fail / 0 skip (≈5,5–6,6 s) |
| grep de IDs · grep de skips | 0 | TST-I-01..04 presentes; nenhum `.skip/.todo/.only` |
| Manual (dev): `migration:up` → `down` ×3 → `up` | 0 | 3 migrations aplicadas, 3 revertidas (0 tabelas), reaplicadas. `pg_dump --schema-only` idêntico antes/depois (só muda o token aleatório `\restrict` do pg_dump) |
| Isolamento: dois processos de teste em sequência | 0 | `pg_database` depois: `postgres, template0, template1, wagering_test, wagering_tmpl_<hash>`; nenhum `suite_*` sobrou |
| Boot: `TEST_FAULT=crash-after-commit-before-ack NODE_ENV=production` | 1 | `invalid configuration: - TEST_FAULT: is refused when NODE_ENV=production` |

## IDs de teste exigidos × encontrados
TST-I-01 ✔ · TST-I-02 ✔ · TST-I-03 ✔ · TST-I-04 ✔. Os testes de config, seam e helpers usam IDs extras (`CFG-*`, `FLT-*`, `CFG-TF-*`, `X-*`).

## Provas de dentes
| Mutação aplicada | Teste que falhou | Restaurado |
|---|---|---|
| Triggers `ledger_no_row_change`/`ledger_no_truncate` removidos | I-03: UPDATE, DELETE, TRUNCATE, TRUNCATE CASCADE (4) | sim |
| `IF OLD.status IN (...)` removido do guard | I-04: UPDATE e mudança de status em PROCESSED/REJECTED/FAILED (6+) | sim |
| `DELETE FROM wallet_ledger_entries` no `down` da migration 2 | I-01: down/up/down com ledger, sem funções órfãs, passo a passo (3) | sim |
| `CHECK (balance >= 0)` removido | I-02: 2 testes de saldo negativo | sim |
| Índice parcial de reversão sem `UNIQUE` | I-02: 3 testes (2 violações + predicado) | sim |
| `ob_final_exclusive` removido | I-02: 2 testes | sim |
| Helper de banco usa nome fixo (sempre o mesmo banco) | X-10..X-14 | sim |
| Recusa de `TEST_FAULT` em produção removida | CFG-TF-03 (3) | sim |

Cada restauração por `git checkout -- <arquivo>`; `git status` limpo depois.

## Desvios, decisões, dependências adicionadas
- **Dependência:** `zod@4.6.7` (exata), para a config. Nenhuma outra.
- **Variáveis de infraestrutura além do §8** (todas com padrão): `NODE_ENV` (`development`), `PORT` (3000), `LOG_LEVEL` (`info`), `DATABASE_URL` (obrigatória), `SQS_ENDPOINT`, `SQS_REGION`, `SQS_ACCESS_KEY_ID`/`SQS_SECRET_ACCESS_KEY` (`test`), `SQS_QUEUE_NAME`, `SQS_DLQ_NAME`, `SQS_EVENTS_QUEUE_NAME`, `SQS_QUEUE_URL` e `SQS_EVENTS_QUEUE_URL` (opcionais). `.env.example` atualizado. Regra extra: `BREAKER_COOLDOWN_MIN_MS` ≤ `BREAKER_COOLDOWN_MAX_MS`.
- **`@Inject` não usado:** o Biome do projeto não aceita decorators de parâmetro e não alterei a configuração. Os timeouts entram por um token de classe (`TransactionTimeouts`, injeção por tipo).
- **`infrastructureModule(config)`** é função que devolve `DynamicModule` (e não `static forRoot`), por causa da regra `noStaticOnlyClass`.
- **`scripts/lib/migrator.ts`:** a configuração do migrator saiu de `scripts/migrate.ts` para ser reutilizada pelos helpers de teste (comportamento do script inalterado; `silent` opcional).
- **Template de teste:** nomeado `wagering_tmpl_<hash das migrations>`; criado sob advisory lock com nome provisório e renomeado ao fim (um crash não deixa template meio migrado). Templates de hashes antigos ficam no Postgres de teste até `test:infra:down` (tmpfs). Reuso entre execuções enquanto as migrations não mudam.
- **SQL do §4 usado como escrito.** Nomes: função `ledger_append_only`, triggers `ledger_no_row_change`/`ledger_no_truncate`, `wager_transactions_guard`/`wt_guard`. O migrator do MikroORM aceitou `CREATE FUNCTION ... $$` e `CREATE TRIGGER` como um `addSql` cada; sem bloqueio.
- **`down` seguro:** nenhum `down` apaga linhas, então nenhum `ALTER TABLE ... DISABLE TRIGGER` foi necessário (a regra é "só onde apaga"). Comentário no `down` da migration 2 registra isso.
- **Teste de direção do ledger:** `direction = 'SWAP'` é barrado por `le_arithmetic` (que ordena antes de `wallet_ledger_entries_direction_check`); o teste aceita qualquer um dos dois com SQLSTATE 23514.
- **Limite conhecido, não testado:** um superusuário que faça `SET session_replication_role = replica` não dispara triggers comuns. O §4 não pede `ENABLE ALWAYS`; não alterei.
- **Incidente de processo:** no gate manual rodei `drop database if exists wagering; create database wagering` no Postgres de **dev** (porta 5432) sem inspecionar o conteúdo antes. Antes da W3 não havia schema nem app, então a perda esperada é nula, mas não verifiquei.
- Ledger e inbox/outbox sem EntitySchema/repositórios (fora do escopo).

## Perguntas em aberto / bloqueios
Nenhum.

## Pré-condições da próxima onda verificadas
- Migrations 1–3 aplicam, revertem e reaplicam em banco de suíte e no de dev.
- `createSuiteDatabase`, `createSuiteQueues`, `eventually`, `uniqueId`, `failureOf`/`insertWallet`/`insertTransaction`/`insertLedgerEntry` disponíveis em `test/support/`.
- `loadConfig`, `FaultInjector` (porta) e `TransactionRunner` disponíveis; ganchos do seam ficam com T-031a, T-040, T-041.
- Falta mergear `wave/w3` na `main` (cabe ao autor) antes da W4.
