# W5 — Plataforma e primeira fatia

**Slot:** quarta noite / quinta manhã · **Branch:** `wave/w5` (a partir da `main` com W4) · **Depende de:** W4 · **Libera:** W6 · **Tamanho:** M

## Prompt (cole na sessão)

```text
Você é a sessão executora da Onda W5 — Plataforma e primeira fatia do desafio Distributed Wagering Processor.
Trabalhe dentro do WSL, na pasta do repositório, branch wave/w5, criada a partir da main que contém a W4.
Leia nesta ordem: CLAUDE.md, specs/README.md, specs/waves/_common.md e specs/waves/W5-plataforma-e-primeira-fatia.md. Depois leia somente a seção "Leitura" deste arquivo.
Execute APENAS T-050, T-051, T-054 e T-030, nesta ordem, com testes primeiro, um commit por tarefa, protocolo de _common.md. Integração com PostgreSQL REAL.
Esta onda cria a plataforma (logs, métricas, auth no-op) e a primeira fatia vertical completa (criar wallet de ponta a ponta). Não altere specs, ADRs nem a ordem de locks. Em dúvida, pare e pergunte (Problema/Opções/Recomendação/Explicação).
Ao final: rode o gate, escreva specs/waves/reports/W5-report.md e informe o veredito com a evidência.
```

## Leitura

[ADR-0018](../adr/0018-observabilidade.md) · [ADR-0017](../adr/0017-autenticacao.md) · [ADR-0012](../adr/0012-http-status-e-erros.md) · [ADR-0005](../adr/0005-money-decimal.md) · [ADR-0014](../adr/0014-outbox-e-eventos.md) · [04-api.md](../04-api.md) §1, §2, §4.2, §7, §8 · [03-messaging.md](../03-messaging.md) §7 (eventos) · [01-requirements.md](../01-requirements.md) RF-OBS-01/02/03, RF-AUT-01, RF-WAL-01/02, RF-API-01..03 · [05-test-plan.md](../05-test-plan.md) TST-U-12, TST-I-17, TST-I-19 · [00-overview.md](../00-overview.md) P-1, P-5, P-10, P-11, P-13 · o código de W4 (`TransactionManager`, repositórios, `main.ts`).

## Pré-condições

`main` com W4: `typecheck`, `lint`, `test:unit`, `test:integration` verdes; `bun src/main.ts` sobe.

## Tarefas

| Tarefa | Entrega | Testes que a fecham |
|---|---|---|
| **T-050** | Logs pino (JSON) + contexto `AsyncLocalStorage` + `redact` + middleware `X-Correlation-Id` | **TST-U-12**; parte de **TST-I-17** (campos dos logs) |
| **T-051** | `MetricsPort` + adaptador prom-client com **todas** as métricas + `GET /metrics` | **TST-I-17** (nomes, tipos, exposição) |
| **T-054** | `AuthGuard` no-op + `@Public()` + `ProviderIdentityPort` | unit (extras `X-*`) |
| **T-030** | `CreateWallet` + `GET /wallets/:id` + `OPENING`/ledger/evento + `ProblemDetailsFilter` inicial | **TST-I-19** |

### Detalhes e armadilhas

**T-050 Logs.** `pino` em JSON (via `nestjs-pino` ou integração equivalente validada no spike). Contexto por requisição/mensagem em `AsyncLocalStorage` com setters para `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`; o logger injeta o contexto em todo log. **Campos permitidos** (única lista): `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, `kind`, `status`, `failureCode`, `errorCode`, `durationMs`, `channel`. **Proibidos:** valores monetários, saldos, corpo do payload, `playerId`, `roundId` (P-1). Combine `redact` do pino **e** um tipo `LogFields` que só aceita as chaves permitidas (erro de compilação para o resto). **Middleware HTTP** (fronteira N15): lê `X-Correlation-Id` ou gera um UUIDv7, grava no contexto e **devolve o header na resposta**. Não registre corpo de requisição/resposta. Testes: **U-12** com objetos de log contendo `amount`, `balance`, `money`, `payload`, `data`, `playerId`, `roundId` em vários níveis de aninhamento → nenhum aparece na saída; parte de I-17: subir o app, chamar um endpoint e verificar nos logs JSON que `correlationId` existe e é o mesmo do header de resposta.

**T-051 Métricas.** Porta `MetricsPort` na camada de aplicação (os casos de uso dependem **dela**, nunca de `prom-client`) + `NoopMetrics` para unitários + adaptador `PromMetrics`. Registre **de uma vez** todas as métricas do [04-api §7](../04-api.md), com nome, tipo e labels exatos: `wager_transactions_total` (counter), `idempotent_requests_total` (counter), `retries_total` (counter), `dlq_messages_total` (counter), `lock_conflicts_total` (counter), `outbox_lag_seconds` (gauge), `outbox_publish_failed_total` (counter), `processing_duration_seconds` (histogram, buckets em segundos com resolução de ms), `reconciliation_divergences_total` (counter), `circuit_breaker_open` (gauge). **Nunca** `walletId`/`playerId`/`transactionId` como label. `prom-client` exige o mesmo conjunto de labels sempre: para `wager_transactions_total` o `failure_code` precisa existir como label com valor neutro quando não há rejeição; escolha o valor neutro, documente e reporte. `GET /metrics` aberto, `Content-Type` do Prometheus. Métricas padrão do Node: conforme o resultado do spike. Teste **I-17**: `/metrics` expõe as 10 métricas (linhas `# TYPE` com o tipo certo); chamar o adaptador incrementa o valor esperado; nenhum label proibido.

**T-054 Auth.** `AuthGuard` global que sempre permite; decorator `@Public()` e verificação de que `/health/*` e `/metrics` seguem abertos mesmo se o guard virar real; `ProviderIdentityPort.resolveProvider(request): ProviderIdentity` + `NoopProviderIdentity` ([ADR-0017](../adr/0017-autenticacao.md)). A forma mínima de `ProviderIdentity` é sua, consistente com o ADR; reporte. O desenho de produção (OIDC/client credentials) é documentação da W11, não código.

**T-030 CreateWallet (primeira fatia vertical).**
- `POST /wallets` (corpo `playerId` uuid + `initialBalance{amount,currency}`) → 201 com `id`, `playerId`, `balance`, `version: 1`. `GET /wallets/:walletId` → 200 / 404 `WALLET_NOT_FOUND`. **`initialBalance` de zero é válido** (P-13 vale só para transações): cria a wallet com `version = 1`, **sem** `OPENING`, sem ledger, sem evento. Negativo, escala errada, uuid inválido → 400 `VALIDATION_ERROR`.
- Saldo > 0: **na mesma transação SQL**: wallet (versão 1) + transação `OPENING` (provider `system`, `external_transaction_id` e `idempotency_key` = `opening:<walletId>` — P-5; status `PROCESSED`, `observed_balance`) + lançamento `CREDIT` (`wallet_version = 1`, `balance_before = 0.00`) + evento **somente** `WalletBalanceChanged` no outbox.
- **Valores não definidos na spec para as colunas `NOT NULL` do `OPENING`** (default adotado; o autor pode vetar): `round_id = 'opening'`, `game_id = 'system'`, `payload_hash` = hash canônico dos campos do próprio `OPENING`. Registre no relatório.
- Duplicada (`playerId` + moeda) → 409 `WALLET_ALREADY_EXISTS`, vindo do `UNIQUE` (23505); **duas criações simultâneas** → uma 201 e uma 409, e nenhuma deixa lixo (transação inteira reverte).
- **`ProblemDetailsFilter` inicial** (fronteira N3): `application/problem+json` (RFC 9457) com `type: about:blank`, `title`, `status`, `errorCode`, `detail`, `correlationId`, `retryable`; cobre `VALIDATION_ERROR` (400), `WALLET_ALREADY_EXISTS` (409), `WALLET_NOT_FOUND` (404), `SERVICE_UNAVAILABLE` (503, `Retry-After: 1`, para `TransientPersistenceError`/`InfrastructureUnavailableError`) e `INTERNAL_ERROR` (500, sem vazar detalhe interno). A T-033 completa o catálogo. Validação com **Zod** (o pipe/validador genérico é consolidado na T-033; aqui só o schema de wallet).
- Instrumente o que já existe: logs com contexto (`walletId` no ALS).
- Testes **I-19** (HTTP real + Postgres real): saldo inicial gera `OPENING` + ledger + evento (conferir o conteúdo do `WalletBalanceChanged` no outbox: `walletId`, `transactionId`, `direction=CREDIT`, `money`, `balanceBefore=0.00`, `balanceAfter`, `walletVersion=1`, `aggregateId` = wallet, `correlationId` = header); saldo zero não gera nada; duplicada = 409; `version = 1`; campos inválidos = 400; `assertLedgerInvariant` ao final.

## Gate

| # | Verificação | Esperado |
|---|---|---|
| 1 | `bun install --frozen-lockfile` · `typecheck` · `lint` | limpos |
| 2 | `bun run test:infra:up` · `test:unit` · `test:integration` (3×) | verdes, 0 skip |
| 3 | IDs exigidos | **TST-U-12, TST-I-17, TST-I-19** (e os das ondas anteriores seguem verdes) |
| 4 | Manual | `curl -XPOST /wallets` e `curl /metrics` e `curl /wallets/:id` no app local; cole as saídas |
| 5 | Varredura de logs | rode um fluxo e `grep` nos logs por valores de saldo/`playerId` → nada |

**Provas de dentes:** remover `playerId` do `redact` e do tipo `LogFields` → U-12; tirar uma métrica do registro → I-17; remover o tratamento do `23505` → teste de duplicada; gravar o ledger fora da transação do `OPENING` (forçar falha entre as duas gravações) → teste de atomicidade da criação; ligar o guard para negar tudo → `/health` e `/metrics` continuam abertos (teste do `@Public`).

## Pare e pergunte se

O `nestjs-pino` ou o `prom-client` se comportarem diferente do spike; a forma de `ProviderIdentity` parecer exigir decisão; surgir dúvida sobre o conteúdo do `OPENING` além do default acima; qualquer tarefa pedir mais de um commit.

## Fora do escopo

`POST /wagering/transactions`, Zod genérico, catálogo completo de erros (T-033), consultas e reconciliação (W7), health (W10).

## Entregáveis

4 commits + relatório · logger + contexto · métricas + `/metrics` · auth no-op · criar/consultar wallet de ponta a ponta.
