# Relatório W7 — API, consultas, reconciliação e concorrência

- Data/hora: 2026-10-28 13:07 (-03) · branch `wave/w7` (a partir da `main` com a W6, `770da73`) · HEAD das tarefas: `6739a62`
- Veredito: **VERDE**

## Tarefas

| Tarefa | Commit | Testes que a fecham (ID → arquivo) | Vermelho → verde |
|---|---|---|---|
| T-033 Controllers, Zod, catálogo de erros, status | `75c43eb` | TST-I-06 e TST-I-07 (nível HTTP) → `test/integration/wagering-http.test.ts` (47 casos) | rota inexistente: 45 de 47 falhavam (404). Os 2 que passavam sem a rota são "corpo que não é JSON → 400" (o body parser já devolvia 400) e "corpo de erro não vaza SQL/stack" (checava só o corpo do 404); depois 47/47 |
| T-034 Consultas e ledger paginado | `48fe563` | TST-I-15 → `test/integration/queries-http.test.ts` (30 casos, 7 de transação + 23 de ledger) | 29 de 30 falhavam (rotas inexistentes; o que passou foi o caso de wallet inexistente, que já dava 404 por outro motivo); depois 30/30 |
| T-035 Reconciliação | `4ca438b` | TST-I-14 → `test/integration/reconciliation-http.test.ts` (10 casos) | 10/10 falhavam (rota inexistente); depois 10/10 |
| T-036 Concorrência da fase | `6739a62` | TST-C-01 (metade HTTP), C-02, C-03, C-09, C-11, C-12 → `test/concurrency/funds-and-idempotency.test.ts` (4) e `test/concurrency/locking.test.ts` (6) | **sem fase vermelha**: o código sob teste já existia (W6) e os 10 testes passaram na primeira execução. A prova de que não são vazios são as provas de dentes abaixo (todas vermelhas) |

Os quatro commits seguem Conventional Commits, sem `Co-Authored-By` e sem atribuição.

## Gate (saída real)

| Comando | Exit | Resumo |
|---|---|---|
| `git status` | — | limpo |
| `bun install --frozen-lockfile` | 0 | 253 installs, sem mudanças |
| `bun run test:infra:up` | 0 | Postgres 5433 + SQS 4567 saudáveis; filas `unchanged` |
| `bun run typecheck` | 0 | limpo |
| `bun run lint` | 0 | 172 arquivos, sem erros nem warnings |
| `bun run test:unit` | 0 | 402 pass / 0 fail / 0 skip, 3,9 s |
| `bun run test:integration` ×3 | 0 | 402 pass / 0 fail / 0 skip nas três (25,0 s · 24,8 s · 24,5 s) |
| `bun run test:concurrency` ×3 | 0 | 10 pass / 0 fail / 0 skip nas três (9,9 s · 9,7 s · 9,8 s) |
| `grep` de skips (`test`, `src`) | — | nada |
| `grep -rn "NotImplementedYet\|NotHandledYet" src` | — | nada |
| `06-tasks.md` vs `main` | — | só T-033..T-036 passaram a `[x]` |
| Deadlocks | — | `pg_stat_database.deadlocks` somado em todo o cluster de teste após as execuções: **0**. Como os bancos de suíte são descartados no fim de cada arquivo (e levam as estatísticas junto), cada arquivo de concorrência também **afirma** no `afterAll` que o contador do seu banco é 0 (isso rodou nas três execuções) |

`assertLedgerInvariant` fecha cada teste de concorrência (por teste, não só no `afterAll`) e as suítes HTTP no `afterAll`. Exceção deliberada: na suíte de reconciliação as wallets adulteradas de propósito (UPDATE direto no saldo, ledger quebrado por SQL) ficam de fora da checagem final; só as saudáveis são conferidas.

## IDs de teste exigidos × encontrados

TST-I-06 ✔ · TST-I-07 ✔ · TST-I-14 ✔ · TST-I-15 ✔ · TST-C-01 ✔ · TST-C-02 ✔ · TST-C-03 ✔ · TST-C-09 ✔ · TST-C-11 ✔ · TST-C-12 ✔ (todos em `test/`; nenhum ausente).

## Contrato HTTP: tabela de status do 04-api §2, linha a linha

| Situação | HTTP | Teste |
|---|---|---|
| `PROCESSED` na 1ª vez | 201 | `wagering-http`: cada `kind` ponta a ponta (BET, WIN com e sem referência, LOSS, REFUND, ROLLBACK) |
| Replay de `PROCESSED` | 200 + `idempotentReplay: true`, saldo observado na época | `wagering-http` TST-I-07 (o saldo da wallet já mudou; a resposta traz 70,00) e C-01 (49 réplicas) |
| `PENDING_REFERENCE` (1ª vez e replay) | 202 | `wagering-http` "PENDING_REFERENCE answers 202…" |
| `REJECTED` (1ª vez e replay) | 422 com `failureCode` | `wagering-http` "REJECTED answers 422…" (`INSUFFICIENT_FUNDS`) e C-02 / C-11 / C-12 |
| `FAILED` (replay) | 422, `balance: null` | `wagering-http` "FAILED replay…" (linha `FAILED` escrita por SQL, ver Desvios) |
| Payload/header inválido (formato, tipo, escala, `OPENING`, valor ≤ 0, chave ausente) | 400 problem+json | `wagering-http`: cerca de 30 testes (chave ausente/vazia/256/não-ASCII/controle, `OPENING`, kind desconhecido, 8 formas de `amount` ruim, `amount` número JSON, moeda minúscula, campo extra, campo extra em `money`, UUID inválido, ids vazios e > 128, campo ausente, `BET` com referência, `REFUND`/`ROLLBACK` sem referência, JSON malformado) |
| Conflito de idempotência / id externo com outra chave | 409 | `wagering-http` TST-I-07 (`IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`, `EXTERNAL_TRANSACTION_ID_CONFLICT`, métrica `idempotent_requests_total{outcome=conflict}`) e C-09 |
| Wallet duplicada | 409 | já coberto na W5 (`wallet-creation.test.ts`) |
| Wallet ou transação inexistente | 404 | `wagering-http` (wallet), `queries-http` (`TRANSACTION_NOT_FOUND` nas duas rotas, `WALLET_NOT_FOUND` no ledger), `reconciliation-http` |
| Falha transitória (`lock_timeout`) | 503 + `Retry-After: 1`, `retryable: true` | `wagering-http` com `55P03` real (conexão crua segura o `FOR UPDATE`, `LOCK_TIMEOUT_MS=300`); `lock_conflicts_total{type=lock_timeout}` +1; a mesma chave funciona depois (201) |
| Bug | 500 sem vazar | `problem-details.test.ts` (W5, controller que lança erro com SQL no `detail`) + o teste de HTTP confere que nenhum corpo de erro contém `select`/`insert`/`stack`/`constraint` |

Formato problem+json (campos `type, title, status, errorCode, detail, correlationId, retryable`, `Content-Type: application/problem+json`, `correlationId` igual ao header `X-Correlation-Id`) conferido em cada 400/404/409/503 de `wagering-http`. `X-Correlation-Id` recebido é devolvido em 2xx e 4xx e aparece nas linhas de log do processo real (`wager transaction concluded` e `request completed`), sem `playerId`.

## Provas de dentes

Feitas no HEAD `6739a62`, sem commitar, restaurando com `git checkout -- src test` e conferindo `git status` (só os arquivos novos da T-036 estavam sem commit na hora das provas 1 a 3; ficaram intactos).

| # | Mutação aplicada | Testes que falharam | Restaurado |
|---|---|---|---|
| 1 | `FOR UPDATE` da wallet vira `SELECT` simples (`mikro-wallet.repository.ts`) | **C-02** (os dois testes), **C-12**, C-11 (os dois), C-03 (30 wallets e o de wallet A travada). 7 de 10 falharam. O sintoma é `500` por `VersionAssertionError` (a asserção de versão do `UPDATE` pega o que o lock deixou passar), não saldo errado | sim |
| 2 | duplicata do `INSERT … ON CONFLICT DO NOTHING` deixa de ser tratada (`resolveDuplicate` vira `throw`) | **C-01** (49 `500` em 50: no paralelo real quase tudo passa pelo caminho do lock, não pelo fast path) | sim |
| 3a | remove a checagem "já revertida" **e** o índice parcial `wt_one_reversal_per_reference` deixa de ser `UNIQUE` (migration, só no banco de teste) | **C-11** (os dois testes: duas reversões `PROCESSED`, saldo creditado em dobro) | sim |
| 3b | remove só a checagem, índice mantido | **C-11** (os dois testes: o índice rejeita e o erro aparece como violação, `500`; o teste espera `REJECTED`) | sim |
| 4 | `pg_advisory_xact_lock(424242)` fixo em toda transação (`transaction-runner.ts`) | **C-03** (wallet A travada: o tráfego da wallet B fica parado e a guarda dispara com `"stuck"`). O teste das 30 wallets continua verde, porque o lock global só serializa e não corrompe | sim |
| 5a | `REJECTED` mapeado para `200` | **I-06 HTTP** "REJECTED answers 422…" (1 falha) | sim |
| 5b | `201`/`200` do replay trocados | **I-06 / I-07 HTTP** (8 falhas: todo `kind` ponta a ponta, replay `200`, chave de 255 caracteres, `lock_timeout` + retry) | sim |
| 6a | reconciliação ignora a cadeia (`continuous = true`) | **I-14** "broken chain", "hole in the versions", "version ahead of its ledger", "both reasons" (4 falhas) | sim |
| 6b | cursor do ledger usa `>` em vez de `<` | **I-15** paginação completa, limites 50/200 e cursor estável sob inserção concorrente (3 falhas) | sim |

Uma correção de teste nasceu da prova 4: na primeira tentativa o C-03 ficou vermelho só por estourar o timeout padrão de 5 s do bun e o `finally` não rodou (o lock vazou para o teste seguinte). Passei o timeout do teste para 60 s e a guarda de "stuck" para 5 s, repeti a prova e agora falha com `Expected: not "stuck"`, com a limpeza executada.

Nenhuma mutação sobreviveu.

## Parâmetros da concorrência (a reportar)

- Processo da aplicação separado (`bun src/main.ts` via `spawnApp`), porta efêmera, banco novo por arquivo; o cliente HTTP é o `fetch` do próprio processo de teste.
- `DB_POOL_MAX=10` (padrão) nos dois arquivos. `LOCK_TIMEOUT_MS=30000` em `funds-and-idempotency` (os 200 pedidos do C-12 esperam em fila no lock de uma única wallet) e `60000` em `locking` (o pedido preso atrás do lock da wallet A precisa continuar preso sem virar 503). `STATEMENT_TIMEOUT_MS` no padrão (15 s).
- O timeout de aquisição do pool não é configurável pelo `AppConfig` e **não foi alterado**. Não apareceu nenhum 503 em nenhuma das 4 execuções verdes da suíte (3 do gate + a primeira), então o pool de 10 não foi o limitante nem mesmo com 200 pedidos simultâneos. Nenhum retry mascara resposta nos testes.
- C-12: ~1 s para os 200 pedidos. C-09: 40 rodadas sequenciais + 40 pares simultâneos (80 pedidos).

## Gate manual (item 5): app local, `curl`

App real (`bun src/main.ts`, porta 3900, banco migrado), saídas coladas do terminal:

```
$ POST /wallets  (100.00)
{"id":"01a18343-eaf3-7603-967f-77542dc3eae7","playerId":"b61d51b3-…","balance":{"amount":"100.00","currency":"BRL"},"version":1}

$ POST /wagering/transactions  BET 30.00  (Idempotency-Key: casino:bet-1)
HTTP/1.1 201 Created
{"transactionId":"01a18343-eb70-…","status":"PROCESSED","balance":{"amount":"70.00","currency":"BRL"},"failureCode":null,"idempotentReplay":false}

$ mesma BET (replay)
HTTP/1.1 200 OK
{"transactionId":"01a18343-eb70-…","status":"PROCESSED","balance":{"amount":"70.00",…},"failureCode":null,"idempotentReplay":true}

$ REFUND de bet-1
HTTP/1.1 201 Created
{"transactionId":"01a18343-eba3-…","status":"PROCESSED","balance":{"amount":"100.00","currency":"BRL"},"failureCode":null,"idempotentReplay":false}

$ ROLLBACK de bet-1 (já revertida)
HTTP/1.1 422 Unprocessable Entity
{"transactionId":"01a18343-ebc3-…","status":"REJECTED","balance":{"amount":"100.00",…},"failureCode":"REFERENCE_ALREADY_REVERSED","idempotentReplay":false}

$ POST sem Idempotency-Key
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json; charset=utf-8
{"type":"about:blank","title":"Idempotency key missing or invalid","status":400,"errorCode":"MISSING_IDEMPOTENCY_KEY","detail":"…","correlationId":"01a18343-ebd4-…","retryable":false}

$ GET /wallets/:id/ledger?limit=2   -> 200, itens v3 (CREDIT 30.00, 70.00→100.00) e v2 (DEBIT 30.00, 100.00→70.00)

$ POST /wallets/:id/reconciliation
HTTP/1.1 200 OK
{"walletId":"01a18343-eaf3-…","storedBalance":{"amount":"100.00",…},"calculatedBalance":{"amount":"100.00",…},"difference":{"amount":"0.00",…},"consistent":true,"checkedEntries":3,"chain":{"continuous":true,"firstBreakAtVersion":null}}

$ (UPDATE direto: balance = 105.00) POST /wallets/:id/reconciliation
HTTP/1.1 200 OK
{"walletId":"01a18343-eaf3-…","storedBalance":{"amount":"105.00",…},"calculatedBalance":{"amount":"100.00",…},"difference":{"amount":"5.00",…},"consistent":false,"checkedEntries":3,"chain":{"continuous":true,"firstBreakAtVersion":null}}

log do app:   {"level":50,…,"walletId":"01a18343-eaf3-…","reason":"balance_mismatch","msg":"reconciliation divergence detected"}
/metrics:     reconciliation_divergences_total 1
```

O banco temporário foi removido e o app encerrado.

## Desvios, decisões, dependências adicionadas

Dependências novas: nenhuma.

1. **Forma do `GET` de transação (decisão minha, a vetar).** Envelope do 04-api §2 (`transactionId`, `status`, `balance`, `failureCode`, `idempotentReplay`) mais `id` (igual a `transactionId`), `providerId`, `externalTransactionId`, `walletId`, `kind`, `money`, `referenceTransactionId`, `createdAt`, `processedAt`. `idempotentReplay` é sempre `false` na consulta (nada foi submetido). `referenceTransactionId`/`processedAt` são `null` quando não há.
2. **`limit` fora de 1..200 é `400 VALIDATION_ERROR`** (default adotado, como o enunciado da onda permite; o autor pode vetar). Também `400` para `limit` não numérico, decimal, negativo ou vazio. `limit` ausente = 50.
3. **Ordem de validação do ledger:** o cursor é decodificado antes de checar a wallet, então cursor inválido em wallet inexistente dá `400 INVALID_CURSOR`, não 404. Cursor aceito só no formato canônico (base64url sem `=` do inteiro decimal positivo ≤ int4, sem zeros à esquerda); cursor "válido" abaixo da primeira versão devolve página vazia com `nextCursor: null`.
4. **Campos de log novos:** `LogFields` ganhou `reason` (código curto) e `firstBreakAtVersion` (posição, não valor), pedidos pela regra de log da reconciliação (`walletId`, motivo, `firstBreakAtVersion`). Nenhum valor monetário entra. Motivos: `balance_mismatch`, `chain_broken`, `balance_mismatch_and_chain_broken`. Não mexi no `FORBIDDEN_KEYS` do pino.
5. **Schema Zod único** em `src/modules/wagering/application/submit-wager-transaction.schema.ts` (importa só `zod`), para a T-042a reaproveitar no SQS. `kind` lista os 5 valores explicitamente (o `OPENING` cai em 400 pelo `enum`). Combinações inválidas de `kind` × referência (`REFUND`/`ROLLBACK` sem referência, `BET` com) viram 400 antes do domínio, conforme a observação 11 do relatório da W6.
6. **Validador genérico consolidado:** `parseWith` + `ZodValidationPipe` em `platform/infrastructure/zod-validation.ts`. Os schemas de wallet passaram a usar `parseWith` (a cópia local de `parse` foi removida). Os controllers novos usam o pipe em body/params.
7. **DI da reconciliação:** `LedgerIntegrityReader` (e a porta `LedgerIntegrityRead`) passaram a ser providos e exportados pelo `InfrastructureModule`, como os demais adaptadores, porque o módulo HTTP da wallet não enxerga o `MikroTransactionManager`.
8. **Reconciliação e o snapshot.** O 04-api §5 descreve uma transação `REPEATABLE READ READ ONLY`; o `LedgerIntegrityReader` da T-025b (reaproveitado, como manda a tarefa) usa **uma única instrução SQL**, que é um snapshot único mesmo em `READ COMMITTED` (ADR-0016). Não alterei o reader. O teste de leituras durante escrita concorrente (40 reconciliações × 40 BETs) não gera falso positivo.
9. **`FAILED` por SQL no teste.** O estado `FAILED` só nasce no caminho de exaustão do SQS (W9), então o teste do replay `FAILED` escreve a linha direto na tabela, com o `payloadHash` calculado pela função do domínio, e chama a API de verdade.
10. **`biome-ignore lint/suspicious/noExplicitAny`** em `test/support/http-app.ts`, no tipo `Reply.body`, com justificativa em comentário (cliente de teste; cada asserção estreita o que lê). É o único em todo o diff.
11. **Suporte de teste novo:** `test/support/http-app.ts` (processo real da app, cliente, leitura de métricas no formato Prometheus, `hashOf`) e `test/support/concurrency.ts` (contador de deadlocks, checagem de invariante em lote, `expectNoServerError`). Para suportar `findPage`, o stub de `LedgerRepository` em `wallet-creation.test.ts` ganhou uma linha.
12. **Provas de dentes mostram uma defesa em profundidade:** sem o `FOR UPDATE` a falha aparece como `500` (`VersionAssertionError`), não como saldo errado. Isso é bom para o produto, mas significa que, sozinho, esse teste não distingue "lock removido" de "versão desalinhada"; o par C-02/C-12 mais o `X-LOCK-ORDER` da W6 cobrem os dois lados.
13. **Observação sem ação (anterior à W7):** rotas inexistentes respondem com o corpo padrão do Nest (JSON), não `application/problem+json`, porque o `ProblemDetailsFilter` da W5 repassa `HttpException` não-400 como estão. Não mexi: está fora das tarefas e o 04-api só lista os erros de negócio.
14. Observação 8 do relatório da W6 (`REFERENCE_ALREADY_REVERSED` também para `WIN`/`LOSS` que apontam para uma `BET` revertida) continua em aberto para o autor; nenhuma mudança minha.

## Perguntas em aberto / bloqueios

Nenhum bloqueio. Para o autor: vetar ou aceitar os itens 1 e 2 acima (forma do `GET` e `limit` fora do intervalo = 400). Nenhum `40P01` real apareceu (0 deadlocks no contador do PostgreSQL), nenhum teste precisou de retry ou espera fixa.

## Pré-condições da próxima onda verificadas

- Caso de uso `SubmitWagerTransaction` provido por `WageringHttpModule` (HTTP). A T-042a alarga `SubmissionContext.channel` e reaproveita `submitWagerTransactionSchema` para o `data` da mensagem SQS.
- `LedgerIntegrityRead`/`assertLedgerInvariant` e o `ProblemDetailsFilter` completos (catálogo do 04-api §4.2 inteiro, `retryable`, `Retry-After: 1`).
- `test/support/http-app.ts` e `test/support/concurrency.ts` prontos para os testes multi-processo (W10) e para a metade SQS do C-01.
- Infra de teste no ar (Postgres 5433, SQS 4567). Árvore limpa antes do commit do relatório.
