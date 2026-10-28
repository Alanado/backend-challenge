# 04 — API

Autenticação: ver ADR-0017 (não implementada; `AuthGuard` no-op e `ProviderIdentityPort`). `/health/*` e `/metrics` são abertos.

## 1. Endpoints

| Método e rota | Sucesso | Descrição |
|---|---|---|
| `POST /wallets` | 201 | Cria wallet. Corpo: `playerId` (uuid), `initialBalance{amount,currency}`. Resposta: `id`, `playerId`, `balance`, `version` |
| `GET /wallets/:walletId` | 200 | `id`, `playerId`, `balance`, `version` |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | 200 | Lançamentos em ordem decrescente de `walletVersion`; `limit` padrão 50, máx. 200; cursor opaco (base64url da `walletVersion`); resposta `{items, nextCursor}`; cursor inválido → 400 |
| `GET /wagering/transactions/:transactionId` | 200 | Estado atual da transação |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | 200 | Idem, por id do provedor |
| `POST /wagering/transactions` | 201/200/202/422 | Submete transação (header `Idempotency-Key`) |
| `POST /wallets/:walletId/reconciliation` | 200 | Reconciliação (sempre 200; divergência em `consistent: false`) |
| `GET /health/live`, `GET /health/ready` | 200/503 | Liveness / readiness |
| `GET /metrics` | 200 | Prometheus |

Cabeçalho opcional `X-Correlation-Id` em toda requisição (gerado se ausente, devolvido na resposta).

## 2. Mapeamento de status HTTP (ADR-0012)

O status do replay **segue o estado atual** da transação. Regra para o provedor: **2xx = aplicou; 422 = não aplicou (definitivo); 202 = aceito, resultado ainda pendente; 5xx = tentar de novo com a mesma chave.**

| Situação | HTTP | Corpo |
|---|---|---|
| `PROCESSED` na primeira vez | **201** | resultado |
| Replay de `PROCESSED` | **200** | resultado, `idempotentReplay: true` |
| `PENDING_REFERENCE` (primeira vez ou replay) | **202** | resultado |
| `REJECTED` (primeira vez ou replay) | **422** | resultado com `failureCode` |
| `FAILED` (replay) | **422** | resultado com `failureCode`, `balance: null` (P-3) |
| Payload/header inválido (formato, tipo, escala, `OPENING`, valor ≤ 0, key ausente) | **400** | problem+json |
| Conflito de idempotência (mesma chave, payload diferente) / `externalTransactionId` já usado com outra chave / wallet duplicada | **409** | problem+json |
| Wallet ou transação inexistente | **404** | problem+json |
| Falha transitória (banco/SQS indisponível, `lock_timeout`, deadlock, pool) | **503** + `Retry-After: 1` | problem+json |
| Bug | **500** | problem+json |

**422 de negócio é definitivo:** o provedor **não** deve reenviá-lo com a mesma chave (o replay devolveria o mesmo resultado).

### Resultado de transação (201/200/202/422)

```json
{
  "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
  "status": "PROCESSED",
  "balance": { "amount": "975.00", "currency": "BRL" },
  "failureCode": null,
  "idempotentReplay": false
}
```
`balance` = `observed_balance` gravado (saldo no momento do resultado). Para `REJECTED` e `PENDING_REFERENCE` é o saldo observado sob o lock da wallet; para `FAILED` é `null`.

### Erro (problem+json, RFC 9457)

```json
{
  "type": "about:blank",
  "title": "Idempotency key reused with a different payload",
  "status": 409,
  "errorCode": "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH",
  "detail": "…",
  "correlationId": "…",
  "retryable": false
}
```

## 3. Submissão (`POST /wagering/transactions`)

Cabeçalho `Idempotency-Key` (1–255 ASCII imprimíveis) obrigatório e fonte da verdade (padrão sugerido `{providerId}:{externalTransactionId}`). Corpo:

| Campo | Regra |
|---|---|
| `providerId` | string 1..128 |
| `externalTransactionId` | string 1..128 |
| `playerId`, `walletId` | uuid |
| `roundId`, `gameId` | string 1..128 |
| `kind` | `BET \| WIN \| LOSS \| REFUND \| ROLLBACK` (`OPENING` → 400) |
| `money` | `{amount: ^\d+\.\d{2}$ (≤17 inteiros, > 0), currency: ^[A-Z]{3}$}` |
| `referenceExternalTransactionId` | obrigatório para `REFUND`/`ROLLBACK`; opcional para `WIN`/`LOSS`; proibido para `BET` |

Campos desconhecidos são rejeitados (400). O mesmo schema Zod valida `data` da mensagem SQS.

## 4. Catálogos

### 4.1 `failureCode` — resultado de negócio **gravado** (`REJECTED`/`FAILED`)

| Código | Quando | Ação esperada do provedor |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` sem saldo | Desistir desta aposta (nova aposta = nova chave) |
| `REVERSAL_WOULD_OVERDRAW` | Reversão deixaria o saldo negativo | Escalar operacionalmente |
| `REFERENCE_NOT_FOUND` | Referência não apareceu após as tentativas | Corrigir ou escalar |
| `REFERENCE_NOT_PROCESSED` | Referência `REJECTED` ou `FAILED` | Desistir |
| `REFERENCE_ALREADY_REVERSED` | Referência já revertida | Desistir (já resolvido) |
| `REFERENCE_MISMATCH` | Player/wallet/moeda/rodada divergem da referência | Corrigir o payload |
| `REFERENCE_KIND_NOT_ALLOWED` | `REFUND` de algo que não é `BET`; `ROLLBACK` de `LOSS`/`ROLLBACK`; `WIN`/`LOSS` de não-`BET` | Corrigir o payload |
| `REVERSAL_AMOUNT_MISMATCH` | Valor da reversão ≠ valor da referência | Corrigir o payload |
| `WALLET_PLAYER_MISMATCH` | Wallet pertence a outro player | Corrigir o payload |
| `WALLET_CURRENCY_MISMATCH` | Moeda ≠ moeda da wallet | Corrigir o payload |
| `PROCESSING_ATTEMPTS_EXHAUSTED` | `FAILED`: infraestrutura, tentativas esgotadas | Tratar como **não aplicado e definitivo**; para tentar de novo, nova transação (novo id externo e nova chave) |

### 4.2 `errorCode` — erro **não** persistido (problem+json)

| Código | HTTP | Retryable |
|---|---|---|
| `VALIDATION_ERROR` | 400 | não |
| `MISSING_IDEMPOTENCY_KEY` | 400 | não |
| `INVALID_CURSOR` | 400 | não |
| `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH` | 409 | não |
| `EXTERNAL_TRANSACTION_ID_CONFLICT` | 409 | não |
| `WALLET_ALREADY_EXISTS` | 409 | não |
| `WALLET_NOT_FOUND` | 404 | não |
| `TRANSACTION_NOT_FOUND` | 404 | não |
| `SERVICE_UNAVAILABLE` | 503 | **sim** (mesma chave) |
| `INTERNAL_ERROR` | 500 | investigar |

`failureCode` significa "resultado de negócio gravado"; quem lê um `failureCode` sabe que a transação existe no banco.

## 5. Reconciliação

`POST /wallets/:walletId/reconciliation` (sem corpo; o `walletId` do corpo no enunciado é redundante com a rota). Lê tudo em **uma** transação `REPEATABLE READ READ ONLY`, sem locks. `calculatedBalance = SUM(CREDIT) − SUM(DEBIT)` sobre todo o ledger (independente do saldo armazenado). Resposta:

```json
{
  "walletId": "…",
  "storedBalance":     { "amount": "975.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "975.00", "currency": "BRL" },
  "difference":        { "amount": "0.00",   "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 42,
  "chain": { "continuous": true, "firstBreakAtVersion": null }
}
```
`consistent` só é `true` se saldo = soma **e** a cadeia está íntegra (cada `balance_before` = `balance_after` anterior; versões consecutivas; primeira versão 1 com `balance_before = 0`, ou 2 se a wallet nasceu zerada; última versão = `wallets.version`). Divergência: log de erro, `reconciliation_divergences_total`++, `consistent: false`; **nunca corrige**.

## 6. `payloadHash` (algoritmo documentado)

1. Montar o objeto de negócio com **exatamente** estes campos: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money{amount,currency}` (amount normalizado `"25.00"`) e `referenceExternalTransactionId` (omitido se ausente).
2. Canonicalizar: ordenar as chaves lexicograficamente (recursivo), sem espaços, strings pelo escape de `JSON.stringify`, UTF-8.
3. `SHA-256` do resultado, em hexadecimal minúsculo.

Ficam **fora** do hash: header `Idempotency-Key`, `messageId`, `occurredAt`, `X-Correlation-Id` e qualquer metadado de transporte.

## 7. Métricas (`GET /metrics`)

| Métrica | Tipo | Labels |
|---|---|---|
| `wager_transactions_total` | counter | `status`, `kind`, `channel` (+ `failure_code` nas rejeições) |
| `idempotent_requests_total` | counter | `outcome` (`replay`\|`conflict`), `channel` |
| `retries_total` | counter | `component` (`consumer`\|`outbox`\|`pending_reference`) |
| `dlq_messages_total` | counter | `reason` |
| `lock_conflicts_total` | counter | `type` (`lock_timeout`\|`deadlock`\|`version_assert`) |
| `outbox_lag_seconds` | gauge | — (idade do evento publicável mais antigo) |
| `outbox_publish_failed_total` | counter | — |
| `processing_duration_seconds` | histogram | `channel`, `kind`, `outcome` |
| `reconciliation_divergences_total` | counter | — |
| `circuit_breaker_open` | gauge | — |

Nunca `walletId`, `playerId` ou `transactionId` como label (cardinalidade).

## 8. Logs

JSON (pino). Campos permitidos: `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, `kind`, `status`, `failureCode`, `errorCode`, `durationMs`, `channel`. **Proibidos:** valores monetários, saldos, corpo do payload, `playerId`, `roundId` (P-1). Redação configurada no pino (`redact`) e testada (TST-U-12).
