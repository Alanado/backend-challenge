# 06 — Tarefas

Regra: **uma tarefa = um commit** (Conventional Commits). Se precisar de mais de um commit, quebre a tarefa. Domínio em TDD (teste primeiro). Cada tarefa lista requisitos/ADRs que a motivam e os testes que a fecham. Marque `[x]` ao concluir.

Definição de pronto de uma tarefa: testes da tarefa verdes, `bun run typecheck` e `bun run lint` limpos, commit feito, nenhuma decisão/spec alterada sem aprovação do autor.

> **Ondas de execução:** o agrupamento das tarefas em sessões (ondas), a ordem real de execução e os prompts estão em [07-waves.md](07-waves.md). A ordem das seções abaixo (M0–M6) é lógica; a ordem de execução é a das ondas. Divisões aprovadas pelo autor em 2026-10-27: T-005→a/b, T-025→a/b, T-031→a/b, T-042→a/b e nova T-026.

## M0 — Spike e scaffold (Dia 1, manhã)

Resultados do spike: ver [adr/0002-spike.md](adr/0002-spike.md).

- [x] **T-001** Scaffold: Bun + TypeScript estrito (`noUncheckedIndexedAccess`), estrutura `src/` e `test/`, scripts, `.gitignore`, `.editorconfig`. *(RNF-01, ADR-0020)*
- [x] **T-002** Spike R-02: Nest + MikroORM (+ `@mikro-orm/nestjs`) sobem no Bun; DI com `emitDecoratorMetadata`; `em.transactional`; `LockMode` (`FOR UPDATE`, `SKIP LOCKED`); migrator `up/down`. Registrar a versão em `adr/0002-spike.md`. *(ADR-0002)*
- [x] **T-003** Spike R-01/R-03: emulador SQS **sem token** (LocalStack fixado em tag anterior a 2026.03, ou MiniStack); validar FIFO, `MessageGroupId`, dedup, DLQ FIFO com redrive, `ChangeMessageVisibility`; AWS SDK v3 no Bun. **Se nenhum funcionar: parar e consultar o autor.**
- [x] **T-004** Spike R-04/R-05: `prom-client` (counter, gauge, histogram, `/metrics`) no Bun; Biome (`noFloatingPromises`, `useImportType` desligado); commitlint + hook sem Husky global.
- [x] **T-005a** `docker-compose.yml` e `docker-compose.test.yml` **somente com Postgres e emulador SQS**; script idempotente de criação de filas; medir a RAM dessa base (R-06). *(RNF-03, RNF-04)*
- [x] **T-005b** *(executada na onda W10, depois que o app sobe)* `Dockerfile` e serviços `app1..3` no `docker-compose.yml`; `docker compose up --build` sobe tudo; medir a RAM completa (R-06). *(RNF-03, RNF-04)*
- [x] **T-006** `CLAUDE.md` com comandos reais e Biome/commitlint ativos; este arquivo atualizado com os resultados do spike.

## M1 — Domínio (Dia 1)

- [x] **T-010** `Money` (big.js, escala 2, parse estrito) + erros de domínio. *(RF-MNY-01..04; TST-U-01, U-02)*
- [x] **T-011** `Wallet` (`open`, `rehydrate`, `debit`, `credit`, `version`) + `WalletLedgerEntry`. *(RF-WAL-03/04, RF-LED-03; TST-U-03, U-07)*
- [x] **T-012** `WagerTransaction` (estados, transições, `ledgerDirectionFor`, `matchesPayload`). *(RF-TXN-01; TST-U-04, U-05)*
- [x] **T-013** `payloadHash` canônico e `IdempotencyKey`. *(RF-IDP-05; TST-U-06)*
- [x] **T-014** `InboxMessage`, `OutboxMessage` (backoff, `isDue`), `IntegrationEvent` + 5 eventos. *(RF-OUT-07; TST-U-08, U-09)*
- [x] **T-015** Políticas de referência/reversão (puras): kind permitido, mismatch, valor, já revertida, `PENDING_REFERENCE`. *(RF-TXN-06..09, 11; TST-U-05)*
- [x] **T-016** Teste de arquitetura de imports. *(RF-MNY-05; TST-U-13)*

## M2 — Persistência (Dia 1)

- [x] **T-020** Config Zod do ambiente + módulo de infraestrutura (MikroORM, pool, timeouts). *(02-design §8)*
- [x] **T-021** Migration 1: `wallets`, `wager_transactions` (constraints, índice parcial de reversão, índices). *(RF-WAL-01, RF-IDP-04/06, RF-TXN-13; TST-I-01, I-02)*
- [x] **T-022** Migration 2: `wallet_ledger_entries` + triggers de imutabilidade + trigger de `wager_transactions`; `down` seguro. *(RF-LED-*, RF-TXN-01; TST-I-01, I-03, I-04)*
- [x] **T-023** Migration 3: `inbox_messages`, `outbox_messages`. *(RF-OUT-*, RF-MSG-02)*
- [x] **T-024** EntitySchemas + mappers + repositórios (wallet com `FOR UPDATE`, transação, ledger, inbox, outbox). *(ADR-0004)*
- [x] **T-025a** *(antes de T-021)* Infra de teste: banco template migrado uma vez, `createSuiteDatabase`, filas por suíte (com DLQ e redrive), `eventually`. *(05-test-plan §2)*
- [x] **T-025b** *(depois de T-024)* `assertLedgerInvariant`: leitura SQL em snapshot em `wallet/infrastructure`, **a mesma função** que T-035 reaproveita na reconciliação; confere `balance = Σ ledger`, cadeia contínua, saldo ≥ 0, `version` coerente. *(ADR-0016, ADR-0019; TST-I-14 parcial)*
- [x] **T-026** *(depois de T-025b)* Bootstrap Nest: `main.ts`, `AppModule` com módulos por papel, flags `ENABLE_*`, `enableShutdownHooks` (esqueleto). Teste: smoke de boot em integração (cada combinação de flags sobe e para). *(ADR-0003, 02-design §1 e §8)*

## M3 — Casos de uso e HTTP (Dia 2, manhã)

- [x] **T-030** `CreateWallet` + `GET /wallets/:id` + OPENING/ledger/evento. *(RF-WAL-01/02; TST-I-19)*
- [x] **T-031a** `SubmitWagerTransaction` — pipeline financeiro: ordem canônica (lock da wallet → `INSERT … ON CONFLICT DO NOTHING` → aplicar), `BET/WIN/LOSS`, `REJECTED` (saldo, player, moeda), ledger, `observed_balance`, outbox. Canal HTTP; o ramo SQS/inbox entra em T-042a. *(RF-TXN-03..05/10, RF-OUT-01; TST-I-05, TST-I-06 no nível do caso de uso)*
- [x] **T-031b** `SubmitWagerTransaction` — idempotência: fast path sem lock, replay com saldo observado, `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`, `EXTERNAL_TRANSACTION_ID_CONFLICT`. *(RF-IDP-01..06; TST-I-07 no nível do caso de uso)*
- [x] **T-032** Reversões e validação de referência (`REFUND`, `ROLLBACK`, `PENDING_REFERENCE` na entrada). *(RF-TXN-06..09/11/13; TST-I-08, I-09)*
- [x] **T-033** Controllers, Zod, problem+json, mapeamento de status, `X-Correlation-Id`. *(RF-API-*)*
- [x] **T-034** Consultas: transação por id e por (provider, external id); ledger paginado. *(RF-LED-04; TST-I-15)*
- [x] **T-035** Reconciliação (snapshot, cadeia). *(RF-REC-*; TST-I-14)*
- [x] **T-036** Testes de concorrência da fase: C-01, C-02, C-03, C-09, C-11, C-12. *(RF-CON-*)*

## M4 — Mensageria e multi-instância (Dia 2, tarde)

- [x] **T-040** Publisher da outbox (`SKIP LOCKED`, lote, backoff, `publish_failed`, métricas de lag). *(RF-OUT-*; TST-I-13, C-06)*
- [x] **T-041** Porta `MessageConsumer` + poller SQS (grupos em série, concorrência entre grupos, visibilidade, timeout). *(RF-MSG-01..04/08)*
- [x] **T-042a** Inbox (ramo SQS do caso de uso, antes do lock da wallet) + classificação de erros (negócio/transitório/infra/permanente). *(RF-MSG-01/02/04, RF-IDP-07; TST-U-11, TST-I-11)*
- [x] **T-042b** DLQ explícita para permanentes + exaustão (`ApproximateReceiveCount >= 8` → `FAILED` + DLQ + delete). *(RF-MSG-04/05/08; TST-I-12)*
- [x] **T-043** Worker de `PENDING_REFERENCE` (ordem wallet→linha, revalidação, acordar dependentes). *(RF-REF-*; TST-I-10, C-07)*
- [x] **T-044** Circuit breaker de infraestrutura. *(RF-MSG-07; TST-I-20)*
- [x] **T-045** Seam de falha (`TEST_FAULT`) com recusa em produção. *(03-messaging §9)*
- [x] **T-046** Testes multi-processo: C-04, C-05, C-08, C-10 + `Bun.spawn` de instâncias.

## M5 — Observabilidade e falhas (Dia 3, manhã)

- [x] **T-050** Logs pino + contexto AsyncLocalStorage + `redact`. *(RF-OBS-01/02; TST-U-12, I-17)*
- [x] **T-051** Métricas Prometheus e `GET /metrics`. *(RF-OBS-03; TST-I-17)*
- [x] **T-052** Health `live`/`ready`. *(RF-OBS-04; TST-I-16)*
- [x] **T-053** Shutdown ordenado (`SIGTERM`) e `stop_grace_period`. *(RF-MSG-06; TST-I-18)*
- [x] **T-054** `AuthGuard` no-op + `ProviderIdentityPort`. *(RF-AUT-01)*

## M6 — Documentação e hardening (Dia 3, tarde)

- [x] **T-060** `README.md` (setup, comandos, como rodar 3 instâncias, como rodar testes, declaração de uso de IA/SDD).
- [ ] **T-061** `ARCHITECTURE.md` (curado a partir dos ADRs: decisões, trade-offs, limitações, ordem de locks, interpretações, taxonomia de falhas, status HTTP).
- [ ] **T-062** Revisão de rastreabilidade: matriz requisito → tarefa → teste sem buracos; `study-guide.md` atualizado com o que mudou na implementação.
- [ ] **T-063** Passada final: suíte completa 3× seguidas (flakiness), cobertura, `docker compose up` do zero.

## Stretch (só com M0–M5 verdes, nesta ordem)

- [ ] **S-01** `bun run test:load` com metodologia, p50/p95/p99, taxa de erro, conflitos de lock, outbox lag; comparar estratégia A (pessimista) com C (`UPDATE` condicionado) em 50 concorrentes.
- [ ] **S-02** Constraint trigger `DEFERRABLE INITIALLY DEFERRED` de consistência saldo×ledger.
- [ ] **S-03** IdP real (Keycloak/Zitadel) atrás do `ProviderIdentityPort`.
- [ ] **S-04** Swagger/OpenAPI a partir dos schemas Zod.
- [ ] **S-05** Partidas dobradas.
- [ ] **S-06** OpenTelemetry.

## Matriz de rastreabilidade (resumo)

| Área | Requisitos | Tarefas | Testes |
|---|---|---|---|
| Money | RF-MNY-* | T-010 | U-01, U-02, U-13 |
| Wallet/Ledger | RF-WAL-*, RF-LED-* | T-011, T-022, T-025b, T-030, T-034 | U-03, U-07, I-02, I-03, I-15, I-19 |
| Transações/regras | RF-TXN-* | T-012, T-015, T-031a, T-032 | U-04, U-05, I-04, I-06, I-08, I-09 |
| Idempotência | RF-IDP-* | T-013, T-021, T-031b | U-06, I-07, C-01, C-08, C-09 |
| Concorrência | RF-CON-* | T-031a, T-036, T-046 | C-01..C-04, C-10..C-12 |
| Referências | RF-REF-* | T-032, T-043 | I-10, C-07 |
| Outbox | RF-OUT-* | T-014, T-023, T-040 | U-08, U-09, I-05, I-13, C-06 |
| Consumidor | RF-MSG-* | T-041, T-042a/b, T-043..T-045, T-053 | I-11, I-12, I-18, I-20, C-05 |
| API/Reconciliação | RF-API-*, RF-REC-* | T-033, T-035 | I-06, I-14 |
| Observabilidade | RF-OBS-* | T-050..T-052 | U-12, I-16, I-17 |
