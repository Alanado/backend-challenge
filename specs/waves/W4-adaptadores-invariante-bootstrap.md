# W4 — Adaptadores, invariante e bootstrap

**Slot:** quarta à tarde/noite · **Branch:** `wave/w4` (a partir da `main` com **W1, W2 e W3 mergeadas**) · **Depende de:** W2 + W3 · **Libera:** W5 · **Tamanho:** G · **CP1** fecha aqui.

## Prompt (cole na sessão)

```text
Você é a sessão executora da Onda W4 — Adaptadores, invariante e bootstrap do desafio Distributed Wagering Processor.
Trabalhe dentro do WSL, na pasta do repositório, branch wave/w4, criada a partir da main que contém W1, W2 e W3.
Leia nesta ordem: CLAUDE.md, specs/README.md, specs/waves/_common.md e specs/waves/W4-adaptadores-invariante-bootstrap.md. Depois leia somente a seção "Leitura" deste arquivo.
Execute APENAS T-024, T-025b e T-026, nesta ordem, com testes primeiro, um commit por tarefa, protocolo de _common.md. Integração com PostgreSQL REAL; sem mocks do banco.
O domínio (W2) já existe e NÃO pode importar ORM/Nest: o acoplamento acontece só em infrastructure, por mappers e rehydrate. Não altere specs nem ADRs, nem a ordem de locks. Em dúvida, pare e pergunte (Problema/Opções/Recomendação/Explicação).
Ao final: rode o gate, escreva specs/waves/reports/W4-report.md e informe o veredito com a evidência.
```

## Leitura

[ADR-0004](../adr/0004-dominio-separado-da-persistencia.md) · [ADR-0006](../adr/0006-concorrencia-lock-pessimista.md) · [ADR-0007](../adr/0007-ordem-de-locks-e-fluxo-transacional.md) · [ADR-0016](../adr/0016-reconciliacao.md) · [ADR-0019](../adr/0019-estrategia-de-testes.md) · [02-design.md](../02-design.md) §1, §4–§8 · [03-messaging.md](../03-messaging.md) §3.2 e §5 (classes de erro) · [04-api.md](../04-api.md) §5 · [05-test-plan.md](../05-test-plan.md) §2 e TST-I-14 · `adr/0002-spike.md` · o domínio em `src/shared` e `src/modules/*/domain` (leia as assinaturas públicas).

## Pré-condições

`main` com W1+W2+W3: `bun run typecheck`, `lint`, `test:unit`, `test:integration` verdes; `test:infra:up` ok; migrations 1–3 aplicam.

## Tarefas

| Tarefa | Entrega | Testes que a fecham |
|---|---|---|
| **T-024** | EntitySchemas + mappers + repositórios + `TransactionManager` | round-trips e locks (extras `X-*`); dá suporte a **TST-I-02** (FKs/UNIQUE na prática) |
| **T-025b** | `LedgerIntegrityReader` (SQL em snapshot) + `assertLedgerInvariant` de teste | **TST-I-14** (parte da invariante) |
| **T-026** | Bootstrap Nest (`main.ts`, `AppModule`, flags `ENABLE_*`, shutdown hooks) | smoke de boot (extras `X-*`), recusa de `TEST_FAULT` em produção |

### T-024 em detalhe

- **EntitySchema** (sem decorators) para wallet, transação, lançamento, inbox e outbox, e **mappers** domínio ↔ linha **sempre via `rehydrate`** (nunca construir via ORM). Dinheiro entra e sai como **string** (`numeric(19,2)`); prove com `"12345678901234567.89"` (17 inteiros) e `"0.01"`.
- **Portas** (interfaces) em `application/` de cada módulo e **implementações** em `infrastructure/`. Mínimo necessário, e as tarefas seguintes estendem o que precisarem no commit delas:
  - `WalletRepository`: `findByIdForUpdate` (**`SELECT … FOR UPDATE`**), `findById`, `findByPlayerAndCurrency`, `insert`, `updateBalance(wallet, expectedVersion)` com `WHERE id AND version = $esperada` (0 linhas afetadas → erro `VersionAssertionError`; **sem retry**, é bug, ADR-0006).
  - `WagerTransactionRepository`: `insertIfAbsent` (`INSERT … ON CONFLICT DO NOTHING` **sem alvo de conflito**, devolve se inseriu), `findById`, `findByIdempotencyKey(providerId, key)`, `findByExternalId(providerId, externalId)`, `findByIdForUpdate`, `update`, `existsProcessedReversalOf(referenceId)`, `wakeDependents(providerId, externalId, walletId, now)`.
  - `LedgerRepository`: `append(entry)`, `findByWallet` básico (a paginação por cursor é T-034).
  - `InboxRepository`: `tryReceive` (`ON CONFLICT DO NOTHING`, devolve se inseriu), `markProcessed`.
  - `OutboxRepository`: `enqueue`.
- **`TransactionManager`** (porta + adaptador): `run(fn)` em transação com `SET LOCAL` de `lock_timeout`/`statement_timeout` (helper da T-020). **Traduz erros do `pg`** em tipos de aplicação (fronteira N14): `55P03`, `40P01`, `57014` → `TransientPersistenceError` (com `kind: lock_timeout | deadlock | statement_timeout`); conexão recusada, `57P01/57P03/08xxx`, pool esgotado, timeout de rede → `InfrastructureUnavailableError`; o resto sobe como está. A classificação para o consumidor (T-042a) é feita **por cima** destes tipos.
- Testes (Postgres real, duas conexões onde precisar): round-trip domínio → banco → domínio para cada agregado (inclui estado terminal reidratado **sem** lançar); `FOR UPDATE` **bloqueia** a segunda transação (prova com `lock_timeout` curto → `55P03` traduzido); `updateBalance` com versão velha devolve falha; `insertIfAbsent` e `tryReceive` com conflito; `wakeDependents` só acorda a wallet informada; tradução de erro para os três tipos (deadlock provocado com dois `FOR UPDATE` cruzados; `statement_timeout` com `pg_sleep`; conexão fechada). O teste de arquitetura (T-016) continua verde.

### T-025b em detalhe

- `LedgerIntegrityReader.read(walletId)` em `wallet/infrastructure`: **uma** leitura consistente (um único `SELECT` com CTE, ou `REPEATABLE READ READ ONLY`), **sem locks**. Devolve: `storedBalance`, `calculatedBalance = Σ CREDIT − Σ DEBIT` (independente do saldo armazenado), `difference`, `checkedEntries`, `chain { continuous, firstBreakAtVersion }`, `consistent`, e dados de apoio (`wallets.version`, última `wallet_version`).
- **Cadeia** ([ADR-0016](../adr/0016-reconciliacao.md)): cada `balance_before` = `balance_after` anterior; versões consecutivas; primeira versão 1 (`balance_before = 0`) ou 2 (wallet nascida zerada); última versão = `wallets.version`. `consistent` só é `true` com saldo = soma **e** cadeia íntegra.
- `test/support/assertLedgerInvariant.ts` chama o reader, confere também saldo ≥ 0 e coerência da `version`, e **lança** com mensagem detalhada se algo falhar. **É a mesma função que a T-035 reaproveita** (a T-035 só soma rota, métrica e log).
- Testes (**TST-I-14**, parte da invariante): wallet consistente (montada via repositórios); `UPDATE wallets SET balance` direto → inconsistente, com `difference` correta; **quebra de cadeia** (insere um lançamento que respeita os CHECKs mas cujo `balance_before` não casa) → `firstBreakAtVersion` correto; buraco de versão; wallet zerada sem lançamentos é consistente; wallet com saldo inicial exige a entrada de versão 1; **leituras repetidas durante escritas concorrentes nunca reportam divergência falsa** (N leituras em loop enquanto outra conexão grava lançamentos+saldo em transações).

### T-026 em detalhe

- `src/main.ts`: carrega a config (`loadConfig`), cria o app Nest, `enableShutdownHooks`, escuta em `PORT`. Falha de config → mensagem legível e **exit code ≠ 0**.
- `AppModule` compõe: módulo de infra (T-020/T-024) e **módulos por papel** habilitados pelas flags `ENABLE_HTTP`, `ENABLE_CONSUMER`, `ENABLE_OUTBOX_PUBLISHER`, `ENABLE_PENDING_WORKER`. Hoje só o papel HTTP tem conteúdo; os demais ganham o *ponto de registro* (um padrão simples, por exemplo providers com `OnApplicationBootstrap`/`OnApplicationShutdown` condicionados à flag) para que T-040, T-041 e T-043 apenas se plugem. Documente o padrão no código.
- Testes de fumaça com **processo real** (`Bun.spawn` de `bun src/main.ts`) e Postgres real: sobe com cada combinação relevante de flags e responde HTTP (qualquer resposta, ex.: 404 JSON); com `ENABLE_HTTP=false` não escuta; `SIGTERM` encerra limpo (pool fechado, exit 0); config inválida → exit ≠ 0 com mensagem; **`NODE_ENV=production` + `TEST_FAULT` → aborta no boot** (fecha o teste de recusa do T-045).

## Gate

| # | Verificação | Esperado |
|---|---|---|
| 1 | `bun install --frozen-lockfile` · `typecheck` · `lint` | limpos |
| 2 | `bun run test:infra:up` · `bun run test:unit` · `bun run test:integration` (3×) | verdes, 0 skip |
| 3 | IDs exigidos | **TST-U-13** (continua), **TST-I-14** (parte da invariante), **TST-I-01..I-04** (continuam) |
| 4 | `grep -rnE "@mikro-orm|@nestjs" src/shared src/modules/*/domain` | nada |
| 5 | `assertLedgerInvariant` | usada em **todo** teste novo desta onda que cria wallet |
| 6 | Boot manual | `bun src/main.ts` sobe e responde; `kill -TERM` encerra limpo |

**Provas de dentes:** trocar `balanceBefore`/`balanceAfter` no mapper → round-trip; trocar `FOR UPDATE` por `SELECT` simples → teste de bloqueio; inverter o sinal de `DEBIT` na soma do reader → testes do I-14; remover o `version = $esperada` do `updateBalance` → teste de versão velha; remover a flag de papel → smoke de flags.

## Pare e pergunte se

O ORM não permitir `FOR UPDATE`/`ON CONFLICT DO NOTHING` sem alvo com o modelo atual (use SQL cru parametrizado — permitido pelo [ADR-0002](../adr/0002-stack-bun-nestjs-mikroorm.md) — mas reporte); um mapper exigir alterar o domínio da W2 (proponha o ajuste, não improvise); T-024 pedir mais de um commit (provável: proponha o corte antes de começar).

## Fora do escopo

Casos de uso, controllers, Zod de entrada, logs, métricas, `ProblemDetailsFilter` (W5), publisher, consumidor, worker.

## Entregáveis

3 commits + relatório · repositórios + `TransactionManager` · `LedgerIntegrityReader` + helper de teste · app que sobe. **CP1:** M0, M1 e M2 completas.
