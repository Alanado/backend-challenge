# W7 — API, consultas, reconciliação e concorrência

**Slot:** quinta (meio do dia) · **Branch:** `wave/w7` (a partir da `main` com W6) · **Depende de:** W6 · **Libera:** W8 e W9 · **Tamanho:** G · **CP2** depende desta onda.

## Prompt (cole na sessão)

```text
Você é a sessão executora da Onda W7 — API, consultas, reconciliação e concorrência do desafio Distributed Wagering Processor.
Trabalhe dentro do WSL, na pasta do repositório, branch wave/w7, criada a partir da main que contém a W6.
Leia nesta ordem: CLAUDE.md, specs/README.md, specs/waves/_common.md e specs/waves/W7-api-reconciliacao-concorrencia.md. Depois leia somente a seção "Leitura" deste arquivo.
Execute APENAS T-033, T-034, T-035 e T-036, nesta ordem, com testes primeiro, um commit por tarefa, protocolo de _common.md. Integração e concorrência com PostgreSQL REAL, paralelismo REAL (Promise.all sobre requisições HTTP reais), nenhum mock do banco.
Os testes de concorrência desta onda são o coração da avaliação: as provas de dentes são obrigatórias. Não altere specs, ADRs nem a ordem de locks. Em dúvida, pare e pergunte (Problema/Opções/Recomendação/Explicação).
Ao final: rode o gate, escreva specs/waves/reports/W7-report.md e informe o veredito com a evidência.
```

## Leitura

[04-api.md](../04-api.md) (inteiro) · [ADR-0012](../adr/0012-http-status-e-erros.md) · [ADR-0016](../adr/0016-reconciliacao.md) · [ADR-0009](../adr/0009-ledger-imutavel.md) · [ADR-0006](../adr/0006-concorrencia-lock-pessimista.md) · [ADR-0007](../adr/0007-ordem-de-locks-e-fluxo-transacional.md) · [ADR-0020](../adr/0020-ferramentas-e-validacao.md) · [01-requirements.md](../01-requirements.md) RF-API-*, RF-IDP-01..06, RF-LED-04, RF-REC-*, RF-CON-01..06 · [05-test-plan.md](../05-test-plan.md) TST-I-06/07/14/15, TST-C-01/02/03/09/11/12 · [00-overview.md](../00-overview.md) P-3, P-6, P-8, P-9, P-10, P-11, P-12 · código da W6 e o `ProblemDetailsFilter` da W5.

## Pré-condições

`main` com W6 verde. O caso de uso `SubmitWagerTransaction` existe para o canal HTTP; `LedgerIntegrityReader` e `assertLedgerInvariant` existem; `ProblemDetailsFilter` inicial existe.

## Tarefas

| Tarefa | Entrega | Testes que a fecham |
|---|---|---|
| **T-033** | Controllers, Zod, catálogo completo de erros, mapeamento de status | **TST-I-06**, **TST-I-07** (nível HTTP) |
| **T-034** | Consultas de transação e ledger paginado por cursor | **TST-I-15** |
| **T-035** | Reconciliação (endpoint sobre o reader da T-025b) | **TST-I-14** |
| **T-036** | Concorrência da fase | **TST-C-01** (metade HTTP), **C-02, C-03, C-09, C-11, C-12** |

### T-033 — controllers, Zod e status

- `POST /wagering/transactions` com header `Idempotency-Key` obrigatório (1–255 ASCII imprimíveis, P-8; ausente/inválido → 400 `MISSING_IDEMPOTENCY_KEY`). Corpo validado por **um schema Zod único e exportado** (será reaproveitado pelo SQS na T-042a): `providerId`/`externalTransactionId`/`roundId`/`gameId` string 1..128; `playerId`/`walletId` UUID; `kind` ∈ `BET|WIN|LOSS|REFUND|ROLLBACK` (**`OPENING` → 400**); `money.amount` `^\d+\.\d{2}$` (≤ 17 inteiros, **> 0**), `currency` `^[A-Z]{3}$`; `referenceExternalTransactionId` obrigatório em `REFUND`/`ROLLBACK`, opcional em `WIN`/`LOSS`, **proibido** em `BET`; **campos desconhecidos → 400** (schema estrito).
- **Mapeamento** exato do [04-api §2](../04-api.md) / ADR-0012: `PROCESSED` 1ª vez **201**, replay **200**; `PENDING_REFERENCE` **202** (1ª vez e replay); `REJECTED` **422** (1ª vez e replay) com `failureCode`; `FAILED` (replay) **422** com `balance: null`; 400/404/409/503/500 em `application/problem+json`. Corpo de resultado: `transactionId`, `status`, `balance`, `failureCode`, `idempotentReplay`.
- **Completar o `ProblemDetailsFilter`** (N3) com todo o catálogo de `errorCode` do [04-api §4.2](../04-api.md) e o campo `retryable`; `TransientPersistenceError`/`InfrastructureUnavailableError` → 503 + `Retry-After: 1`; erro inesperado → 500 `INTERNAL_ERROR` **sem vazar** stack nem SQL. `X-Correlation-Id` já existe (N15): aqui só o teste do contrato HTTP.
- Consolide o validador Zod genérico (pipe) que a T-030 deixou parcial.
- **Testes I-06/I-07 no nível HTTP** (servidor real em porta efêmera + Postgres real): cada `kind` ponta a ponta; **todas** as linhas da tabela de status; formato problem+json (campos obrigatórios); replay `200` com `idempotentReplay: true` e saldo observado; payload divergente 409; id externo com outra chave 409; chave ausente 400; `OPENING` 400; amount ≤ 0 400; campo extra 400; `lock_timeout` real (segure o lock da wallet numa conexão crua, config de `LOCK_TIMEOUT_MS` curta no teste) → **503** com `Retry-After` e `lock_conflicts_total{type=lock_timeout}` incrementado; `X-Correlation-Id` recebido é devolvido e aparece nos logs; 404 de wallet inexistente.

### T-034 — consultas

- `GET /wagering/transactions/:transactionId` e `GET /providers/:providerId/wagering/transactions/:externalTransactionId`: 200 com o **estado atual** (envelope de resultado do 04-api §2 acrescido dos identificadores: `id`, `providerId`, `externalTransactionId`, `walletId`, `kind`, `money`, `referenceTransactionId`, `createdAt`, `processedAt` — forma mínima sua, **reporte**); 404 `TRANSACTION_NOT_FOUND`.
- `GET /wallets/:walletId/ledger?cursor=&limit=`: ordem **decrescente** de `wallet_version` (P-6); `limit` padrão 50, máximo 200 (valor fora de 1..200 → 400 `VALIDATION_ERROR`, default adotado — o autor pode vetar; reporte); cursor opaco = base64url da `wallet_version` do último item; `nextCursor: null` na última página; cursor inválido → 400 `INVALID_CURSOR`; wallet inexistente → 404. Itens: `id`, `transactionId`, `walletVersion`, `direction`, `money`, `balanceBefore`, `balanceAfter`, `createdAt`. Busca `limit + 1` para saber se há próxima página.
- **Testes I-15:** paginação completa sem repetir nem pular item; **cursor estável sob inserções concorrentes** (caminhe pelas páginas enquanto outra conexão acrescenta lançamentos: nada repete, nada some dentro do snapshot já percorrido); limites (1, 50, 200, 0, 201); cursor inválido (lixo, base64 válido de não-número, negativo).

### T-035 — reconciliação

- `POST /wallets/:walletId/reconciliation` (sem corpo; o `walletId` do corpo do enunciado é redundante com a rota) → **sempre 200**, com `walletId`, `storedBalance`, `calculatedBalance`, `difference`, `consistent`, `checkedEntries`, `chain { continuous, firstBreakAtVersion }` ([04-api §5](../04-api.md)). **Reutiliza o `LedgerIntegrityReader` da T-025b** (mesma função do `assertLedgerInvariant`). Wallet inexistente → 404.
- Divergência: **log de erro sem valores** (apenas `walletId`, motivo, `firstBreakAtVersion` — regra de logs), `reconciliation_divergences_total`++, `consistent: false`. **Nunca corrige.**
- **Testes I-14 completos:** consistente; divergência induzida (`UPDATE wallets SET balance` direto) → `consistent: false`, `difference` correta, métrica incrementada, log emitido **sem** saldos; quebra de cadeia e buraco de versão detectados; snapshot único (leituras durante escrita concorrente não geram falso positivo); a reconciliação **não** pega lock (uma wallet com `FOR UPDATE` segurado por outra conexão ainda é reconciliada sem bloquear).

### T-036 — concorrência da fase

Servidor real em porta efêmera, pool real, requisições HTTP reais em paralelo (`Promise.all`). Cada teste usa wallets novas; nenhum depende de tempo fixo. Todos terminam com `assertLedgerInvariant`.

| ID | Cenário | Afirmações |
|---|---|---|
| **C-01 (HTTP)** | Mesma `BET` 50× em paralelo (mesma chave e mesmo corpo) | exatamente 1 resposta `201` + 49 `200` com `idempotentReplay: true`; **1** débito; mesmo `transactionId` em todas; saldo certo. A metade SQS fecha na T-042a (N4) |
| **C-02** | Saldo 100,00, duas `BET` de 80,00 simultâneas, repetido em ≥ 20 wallets/rodadas | por rodada: 1 `PROCESSED` (201) + 1 `REJECTED` (422 `INSUFFICIENT_FUNDS`); saldo final 20,00; **1** `DEBIT`; nenhum 5xx |
| **C-03** | Wallets distintas em paralelo, sem lock global | prove de forma **determinística**, sem medir tempo: segure `FOR UPDATE` na wallet A numa conexão crua e processe com sucesso várias `BET` na wallet B dentro de um prazo bem menor que `LOCK_TIMEOUT_MS`; depois solte A e processe a pendente de A. Complemente com N wallets em paralelo, todas corretas |
| **C-09** | Mesmo `externalTransactionId` em wallets diferentes, chaves diferentes, em paralelo (repetir muitas vezes) | um vence (201), o outro **409** `EXTERNAL_TRANSACTION_ID_CONFLICT`; **zero** `40P01`/503 (confira `lock_conflicts_total{type=deadlock}` = 0 e `pg_stat_database.deadlocks` sem aumento) |
| **C-11** | `REFUND` e `ROLLBACK` da mesma `BET` em paralelo (repetir) | exatamente **uma** `PROCESSED`; a outra `REJECTED` `REFERENCE_ALREADY_REVERSED`; saldo restaurado uma só vez |
| **C-12** | Wallet quente: 100,00 e 200 `BET` de 1,00 simultâneas (ids/chaves únicos) | exatamente 100 `PROCESSED` e 100 `REJECTED`; saldo 0,00; 100 lançamentos com `wallet_version` 2..101 contíguas; **nenhuma** resposta 5xx |

Cuidados: com pool de 10 e 200 requisições simultâneas, ajuste o timeout de aquisição do pool e o `LOCK_TIMEOUT_MS` **do teste** para que o limitante seja a lógica, não a espera por conexão, e **reporte** os valores. Não esconda 503 com retry no teste: se aparecer, é achado, não ruído.

## Gate

| # | Verificação | Esperado |
|---|---|---|
| 1 | `bun install --frozen-lockfile` · `typecheck` · `lint` | limpos |
| 2 | `bun run test:infra:up` · `test:unit` · `test:integration` · `test:concurrency` (3×) | verdes, 0 skip |
| 3 | IDs exigidos | **TST-I-06, I-07, I-14, I-15, TST-C-01, C-02, C-03, C-09, C-11, C-12** |
| 4 | Contrato HTTP | tabela de status do 04-api §2 coberta linha a linha (liste no relatório) |
| 5 | Manual | `curl` de um fluxo `BET → REFUND` e da reconciliação no app local (cole as saídas) |
| 6 | Deadlocks | `pg_stat_database.deadlocks` do banco da suíte = 0 após `test:concurrency` |

**Provas de dentes (obrigatórias, registre todas):**
1. Troque o `FOR UPDATE` da wallet por `SELECT` simples → **C-02 e C-12 precisam ficar vermelhos**.
2. Remova o tratamento de conflito/releitura da idempotência → **C-01 vermelho**.
3. Remova a checagem "já revertida" **e** o índice parcial (só no banco de teste) → **C-11 vermelho**; com o índice mantido, o erro aparece como violação (teste ainda vermelho porque espera `REJECTED`).
4. Adicione um `lock` global (ex.: advisory lock fixo em toda transação) → **C-03 vermelho**.
5. Mapeie `REJECTED` para 200 → I-06 (HTTP) vermelho. Troque `201`/`200` do replay → I-07 vermelho.
6. Faça a reconciliação ignorar a cadeia → I-14 vermelho. Faça o cursor usar `>` em vez de `<` → I-15 vermelho.

## Pare e pergunte se

O formato do estado da transação (GET) ou algum limite (ex.: `limit > 200`) parecer exigir decisão além do default acima; um teste de concorrência só passar com retry ou espera fixa; aparecer `40P01` real (isso invalida a ordem de locks — **não improvise**); o pool for o gargalo estrutural; qualquer tarefa pedir mais de um commit.

## Fora do escopo

Ramo SQS e inbox (T-042a), publisher, worker de pendentes, instâncias múltiplas por processo (W10), health.

## Entregáveis

4 commits + relatório · API HTTP completa · **CP2** (junto com a W8): núcleo financeiro, API e concorrência provados.
