# Matriz de rastreabilidade

> Arquivo **gerado** por `bun scripts/check-traceability.ts` a partir de `01-requirements.md`, `05-test-plan.md`, `06-tasks.md` e dos títulos em `test/`. Não edite à mão: rode o script para regenerar. Sem data de propósito (a saída é determinística).

## Resumo

- Requisitos: 78 (72 com `TST-*`, 6 com verificação por comando ou revisão).
- Testes do plano: 45; citados em títulos de teste: 45.
- Tarefas T: 47 de 47 concluídas.

## Requisito → tarefa → teste

Tarefas = as que citam o requisito ou um dos seus testes (06-tasks). Testes = `TST-*` citados no requisito, com os arquivos cujos títulos os contêm.

### 1. Money

| Requisito | Tarefas | Testes → arquivos |
|---|---|---|
| **RF-MNY-01** `Money` é imutável; entrada e saída são string decimal com escala 2 | T-010 | TST-U-01: [money.test.ts](../test/unit/shared/money.test.ts)<br>TST-U-02: [money.test.ts](../test/unit/shared/money.test.ts) |
| **RF-MNY-02** Rejeita entradas inválidas | T-010 | TST-U-01: [money.test.ts](../test/unit/shared/money.test.ts) |
| **RF-MNY-03** Aritmética exata e conflito de moeda | T-010 | TST-U-02: [money.test.ts](../test/unit/shared/money.test.ts) |
| **RF-MNY-04** Nenhum `number` representa dinheiro | T-010 | TST-U-02: [money.test.ts](../test/unit/shared/money.test.ts) |
| **RF-MNY-05** Domínio independe de ORM e decorators NestJS | T-016 | TST-U-13: [architecture.test.ts](../test/unit/architecture.test.ts) |

### 2. Wallet

| Requisito | Tarefas | Testes → arquivos |
|---|---|---|
| **RF-WAL-01** Uma wallet por (`playerId`, `currency`); `version` inicia em 1 | T-021, T-030 | TST-I-02: [ledger-constraints.test.ts](../test/integration/ledger-constraints.test.ts), [messaging-schema.test.ts](../test/integration/messaging-schema.test.ts), [schema-constraints.test.ts](../test/integration/schema-constraints.test.ts)<br>TST-I-19: [problem-details.test.ts](../test/integration/problem-details.test.ts), [wallet-creation.test.ts](../test/integration/wallet-creation.test.ts) |
| **RF-WAL-02** Saldo inicial > 0 gera `OPENING` + lançamento `CREDIT` + evento `WalletBalanceChanged` na mesma transação SQL; saldo 0 não gera nada | T-030 | TST-I-19: [problem-details.test.ts](../test/integration/problem-details.test.ts), [wallet-creation.test.ts](../test/integration/wallet-creation.test.ts) |
| **RF-WAL-03** Saldo nunca negativo | T-011, T-021, T-036 | TST-C-12: [funds-and-idempotency.test.ts](../test/concurrency/funds-and-idempotency.test.ts)<br>TST-I-02: [ledger-constraints.test.ts](../test/integration/ledger-constraints.test.ts), [messaging-schema.test.ts](../test/integration/messaging-schema.test.ts), [schema-constraints.test.ts](../test/integration/schema-constraints.test.ts)<br>TST-U-03: [wallet.test.ts](../test/unit/wallet/wallet.test.ts) |
| **RF-WAL-04** `version` incrementa **somente** quando o saldo muda | T-011, T-031a | TST-I-06: [submit-wager-transaction.test.ts](../test/integration/submit-wager-transaction.test.ts), [wagering-http.test.ts](../test/integration/wagering-http.test.ts)<br>TST-U-03: [wallet.test.ts](../test/unit/wallet/wallet.test.ts) |
| **RF-WAL-05** Moeda da operação = moeda da wallet | T-032 | TST-I-09: [submit-references.test.ts](../test/integration/submit-references.test.ts) |

### 3. Transações e regras de negócio

| Requisito | Tarefas | Testes → arquivos |
|---|---|---|
| **RF-TXN-01** Ciclo de vida: `PENDING → PROCESSED | REJECTED | PENDING_REFERENCE | FAILED`; `PENDING_REFERENCE → PROCESSED | REJECTED | FAILED`; terminais imutáveis | T-012, T-022 | TST-I-04: [wager-transactions-guard.test.ts](../test/integration/wager-transactions-guard.test.ts)<br>TST-U-04: [wager-transaction.test.ts](../test/unit/wagering/wager-transaction.test.ts) |
| **RF-TXN-02** `OPENING` não pode ser submetido por API nem fila | T-031a, T-042b | TST-I-06: [submit-wager-transaction.test.ts](../test/integration/submit-wager-transaction.test.ts), [wagering-http.test.ts](../test/integration/wagering-http.test.ts)<br>TST-I-12: [consumer-role.test.ts](../test/integration/consumer-role.test.ts), [sqs-consumer-dlq.test.ts](../test/integration/sqs-consumer-dlq.test.ts) |
| **RF-TXN-03** `BET` debita; sem saldo → `REJECTED` `INSUFFICIENT_FUNDS`, sem ledger | T-012, T-015, T-031a | TST-I-06: [submit-wager-transaction.test.ts](../test/integration/submit-wager-transaction.test.ts), [wagering-http.test.ts](../test/integration/wagering-http.test.ts)<br>TST-U-05: [transaction-policy.test.ts](../test/unit/wagering/transaction-policy.test.ts), [wager-transaction.test.ts](../test/unit/wagering/wager-transaction.test.ts) |
| **RF-TXN-04** `WIN` credita; referência opcional (se presente, deve ser `BET`) | T-012, T-015, T-031a | TST-I-06: [submit-wager-transaction.test.ts](../test/integration/submit-wager-transaction.test.ts), [wagering-http.test.ts](../test/integration/wagering-http.test.ts)<br>TST-U-05: [transaction-policy.test.ts](../test/unit/wagering/transaction-policy.test.ts), [wager-transaction.test.ts](../test/unit/wagering/wager-transaction.test.ts) |
| **RF-TXN-05** `LOSS` não move saldo nem gera ledger | T-012, T-015, T-031a | TST-I-06: [submit-wager-transaction.test.ts](../test/integration/submit-wager-transaction.test.ts), [wagering-http.test.ts](../test/integration/wagering-http.test.ts)<br>TST-U-05: [transaction-policy.test.ts](../test/unit/wagering/transaction-policy.test.ts), [wager-transaction.test.ts](../test/unit/wagering/wager-transaction.test.ts) |
| **RF-TXN-06** `REFUND` reverte uma `BET` `PROCESSED` (crédito do mesmo valor) | T-015, T-032 | TST-I-08: [submit-references.test.ts](../test/integration/submit-references.test.ts) |
| **RF-TXN-07** `ROLLBACK` reverte `BET`, `WIN` ou `REFUND` `PROCESSED` com lançamento inverso | T-015, T-032 | TST-I-08: [submit-references.test.ts](../test/integration/submit-references.test.ts) |
| **RF-TXN-08** Valor da reversão é **igual** ao da referência | T-015, T-032 | TST-I-09: [submit-references.test.ts](../test/integration/submit-references.test.ts) |
| **RF-TXN-09** Reversão que deixaria saldo negativo é rejeitada com código distinto | T-015, T-032 | TST-I-08: [submit-references.test.ts](../test/integration/submit-references.test.ts) |
| **RF-TXN-10** `REJECTED` persiste a transação sem alterar saldo nem gerar ledger | T-031a | TST-I-06: [submit-wager-transaction.test.ts](../test/integration/submit-wager-transaction.test.ts), [wagering-http.test.ts](../test/integration/wagering-http.test.ts) |
| **RF-TXN-11** Referência resolvida por (`providerId`, `referenceExternalTransactionId`) **sem filtro de wallet**; depois valida kind permitido, mesma wallet/player/moeda/rodada, status e se já foi revertida | T-015, T-032 | TST-I-09: [submit-references.test.ts](../test/integration/submit-references.test.ts) |
| **RF-TXN-12** Toda rejeição/falha carrega `failureCode` do catálogo estável | T-031a, T-042a | TST-I-06: [submit-wager-transaction.test.ts](../test/integration/submit-wager-transaction.test.ts), [wagering-http.test.ts](../test/integration/wagering-http.test.ts)<br>TST-U-11: [classify-message-error.test.ts](../test/unit/wagering/classify-message-error.test.ts), [wager-transaction-message.test.ts](../test/unit/wagering/wager-transaction-message.test.ts) |
| **RF-TXN-13** No máximo **uma** reversão `PROCESSED` por transação referenciada, de qualquer tipo | T-021, T-032, T-036 | TST-C-11: [locking.test.ts](../test/concurrency/locking.test.ts)<br>TST-I-08: [submit-references.test.ts](../test/integration/submit-references.test.ts) |

### 4. Ledger

| Requisito | Tarefas | Testes → arquivos |
|---|---|---|
| **RF-LED-01** Toda mudança de saldo tem exatamente uma entrada e vice-versa; no máximo uma por (wallet, transação) | T-022, T-025b, T-031a, T-035 | TST-I-05: [submit-wager-transaction.test.ts](../test/integration/submit-wager-transaction.test.ts)<br>TST-I-14: [ledger-integrity.test.ts](../test/integration/ledger-integrity.test.ts), [reconciliation-http.test.ts](../test/integration/reconciliation-http.test.ts), [repositories.test.ts](../test/integration/repositories.test.ts), [transaction-manager.test.ts](../test/integration/transaction-manager.test.ts) |
| **RF-LED-02** Ledger é append-only | T-022 | TST-I-03: [ledger-constraints.test.ts](../test/integration/ledger-constraints.test.ts) |
| **RF-LED-03** Lançamento balanceado | T-011, T-021, T-022 | TST-I-02: [ledger-constraints.test.ts](../test/integration/ledger-constraints.test.ts), [messaging-schema.test.ts](../test/integration/messaging-schema.test.ts), [schema-constraints.test.ts](../test/integration/schema-constraints.test.ts)<br>TST-U-07: [wallet-ledger-entry.test.ts](../test/unit/wallet/wallet-ledger-entry.test.ts) |
| **RF-LED-04** Ordem total por wallet e paginação por cursor opaco e estável | T-022, T-034 | TST-I-15: [queries-http.test.ts](../test/integration/queries-http.test.ts) |

### 5. Idempotência

| Requisito | Tarefas | Testes → arquivos |
|---|---|---|
| **RF-IDP-01** Header `Idempotency-Key` obrigatório e fonte da verdade (padrão sugerido `{providerId}:{externalTransactionId}`) | T-031b | TST-I-07: [submit-idempotency.test.ts](../test/integration/submit-idempotency.test.ts), [wagering-http.test.ts](../test/integration/wagering-http.test.ts) |
| **RF-IDP-02** Replay devolve o **resultado original** (incluindo o saldo observado) com `idempotentReplay: true` | T-031b | TST-I-07: [submit-idempotency.test.ts](../test/integration/submit-idempotency.test.ts), [wagering-http.test.ts](../test/integration/wagering-http.test.ts) |
| **RF-IDP-03** Mesma chave com payload diferente é conflito | T-013, T-031b | TST-I-07: [submit-idempotency.test.ts](../test/integration/submit-idempotency.test.ts), [wagering-http.test.ts](../test/integration/wagering-http.test.ts)<br>TST-U-06: [hash.test.ts](../test/unit/shared/hash.test.ts), [payload-hash.test.ts](../test/unit/wagering/payload-hash.test.ts) |
| **RF-IDP-04** Deduplicação persistente, nunca em memória | T-021, T-031b, T-046 | TST-C-08: [multi-instance-restart.test.ts](../test/concurrency/multi-instance-restart.test.ts)<br>TST-I-07: [submit-idempotency.test.ts](../test/integration/submit-idempotency.test.ts), [wagering-http.test.ts](../test/integration/wagering-http.test.ts) |
| **RF-IDP-05** `payloadHash` = SHA-256 hex do JSON canônico dos campos de negócio | T-013, T-031b | TST-U-06: [hash.test.ts](../test/unit/shared/hash.test.ts), [payload-hash.test.ts](../test/unit/wagering/payload-hash.test.ts) |
| **RF-IDP-06** `externalTransactionId` é único por provedor | T-021, T-031b, T-036 | TST-C-09: [locking.test.ts](../test/concurrency/locking.test.ts)<br>TST-I-07: [submit-idempotency.test.ts](../test/integration/submit-idempotency.test.ts), [wagering-http.test.ts](../test/integration/wagering-http.test.ts) |
| **RF-IDP-07** HTTP e SQS compartilham o espaço de chaves | T-042a | TST-I-11: [consumer-role.test.ts](../test/integration/consumer-role.test.ts), [sqs-consumer-inbox.test.ts](../test/integration/sqs-consumer-inbox.test.ts) |

### 6. Concorrência

| Requisito | Tarefas | Testes → arquivos |
|---|---|---|
| **RF-CON-01** Duas `BET` de 80,00 simultâneas com saldo 100,00 | T-036 | TST-C-02: [funds-and-idempotency.test.ts](../test/concurrency/funds-and-idempotency.test.ts) |
| **RF-CON-02** A mesma `BET` 50× em paralelo | T-036 | TST-C-01: [consumer-idempotency.test.ts](../test/concurrency/consumer-idempotency.test.ts), [funds-and-idempotency.test.ts](../test/concurrency/funds-and-idempotency.test.ts) |
| **RF-CON-03** Wallets diferentes em paralelo, sem lock global | T-036 | TST-C-03: [locking.test.ts](../test/concurrency/locking.test.ts) |
| **RF-CON-04** Correto com ≥ 3 instâncias simultâneas (HTTP + SQS) | T-036, T-046 | TST-C-04: [multi-instance-load.test.ts](../test/concurrency/multi-instance-load.test.ts) |
| **RF-CON-05** Sem deadlock: ordem canônica de locks (inbox → wallet → `wager_transactions`) | T-036, T-046 | TST-C-10: [multi-instance-mixed-load.test.ts](../test/concurrency/multi-instance-mixed-load.test.ts) |
| **RF-CON-06** `lock_timeout` e deadlock são falhas **transitórias** | T-036, T-042b, T-046 | TST-C-10: [multi-instance-mixed-load.test.ts](../test/concurrency/multi-instance-mixed-load.test.ts)<br>TST-I-12: [consumer-role.test.ts](../test/integration/consumer-role.test.ts), [sqs-consumer-dlq.test.ts](../test/integration/sqs-consumer-dlq.test.ts) |

### 7. Referências fora de ordem

| Requisito | Tarefas | Testes → arquivos |
|---|---|---|
| **RF-REF-01** Referência ausente → `PENDING_REFERENCE` + evento `WagerTransactionPendingReference` (uma vez) | T-043 | TST-I-10: [pending-worker-role.test.ts](../test/integration/pending-worker-role.test.ts), [pending-worker.test.ts](../test/integration/pending-worker.test.ts) |
| **RF-REF-02** Worker reprocessa com backoff exponencial (6 tentativas, base 5 s, fator 2, jitter, teto 5 min — configurável); esgotado → `REJECTED` `REFERENCE_NOT_FOUND` + `WagerTransactionRejected` | T-043 | TST-I-10: [pending-worker-role.test.ts](../test/integration/pending-worker-role.test.ts), [pending-worker.test.ts](../test/integration/pending-worker.test.ts)<br>TST-U-10: [reference-backoff.test.ts](../test/unit/wagering/reference-backoff.test.ts) |
| **RF-REF-03** Quando uma transação é processada, dependentes **da mesma wallet** ficam vencidas na hora | T-043 | TST-I-10: [pending-worker-role.test.ts](../test/integration/pending-worker-role.test.ts), [pending-worker.test.ts](../test/integration/pending-worker.test.ts) |
| **RF-REF-04** Vários workers/instâncias não processam a mesma pendente duas vezes | T-043 | TST-C-07: [pending-worker.test.ts](../test/concurrency/pending-worker.test.ts) |
| **RF-REF-05** `ROLLBACK`/`REFUND` entregue antes da referência termina `PROCESSED` quando a referência chega | T-043 | TST-C-07: [pending-worker.test.ts](../test/concurrency/pending-worker.test.ts) |

### 8. Outbox

| Requisito | Tarefas | Testes → arquivos |
|---|---|---|
| **RF-OUT-01** Saldo, ledger, transação, inbox e outbox na mesma transação SQL | T-023, T-031a, T-040 | TST-I-05: [submit-wager-transaction.test.ts](../test/integration/submit-wager-transaction.test.ts) |
| **RF-OUT-02** Evento nunca publicado antes do commit | T-023, T-040 | TST-I-13: [outbox-publisher.test.ts](../test/integration/outbox-publisher.test.ts), [outbox-role.test.ts](../test/integration/outbox-role.test.ts) |
| **RF-OUT-03** Vários publishers sem perder nem duplicar indefinidamente | T-023, T-040 | TST-C-06: [multi-instance-publisher-crash.test.ts](../test/concurrency/multi-instance-publisher-crash.test.ts), [outbox-publishers.test.ts](../test/concurrency/outbox-publishers.test.ts)<br>TST-I-13: [outbox-publisher.test.ts](../test/integration/outbox-publisher.test.ts), [outbox-role.test.ts](../test/integration/outbox-role.test.ts) |
| **RF-OUT-04** Processo morre após o commit e antes de publicar; outra instância assume | T-023, T-040 | TST-C-06: [multi-instance-publisher-crash.test.ts](../test/concurrency/multi-instance-publisher-crash.test.ts), [outbox-publishers.test.ts](../test/concurrency/outbox-publishers.test.ts) |
| **RF-OUT-05** `eventId` estável entre republicações; consumidor deduplica | T-023, T-040 | TST-I-13: [outbox-publisher.test.ts](../test/integration/outbox-publisher.test.ts), [outbox-role.test.ts](../test/integration/outbox-role.test.ts) |
| **RF-OUT-06** Erro transitório: retry com backoff (teto 60 s) sem limite; erro permanente: `publish_failed` + alerta | T-023, T-040 | TST-I-13: [outbox-publisher.test.ts](../test/integration/outbox-publisher.test.ts), [outbox-role.test.ts](../test/integration/outbox-role.test.ts) |
| **RF-OUT-07** Eventos por cenário conforme 03-messaging §6 | T-014, T-023, T-031a, T-040 | TST-I-06: [submit-wager-transaction.test.ts](../test/integration/submit-wager-transaction.test.ts), [wagering-http.test.ts](../test/integration/wagering-http.test.ts)<br>TST-U-09: [integration-events.test.ts](../test/unit/messaging/integration-events.test.ts) |

### 9. Consumidor SQS

| Requisito | Tarefas | Testes → arquivos |
|---|---|---|
| **RF-MSG-01** Reutiliza o **mesmo caso de uso** da entrada HTTP | T-041, T-042a | TST-I-11: [consumer-role.test.ts](../test/integration/consumer-role.test.ts), [sqs-consumer-inbox.test.ts](../test/integration/sqs-consumer-inbox.test.ts) |
| **RF-MSG-02** Deduplicação por inbox `(consumerName, messageId)` | T-023, T-041, T-042a | TST-I-11: [consumer-role.test.ts](../test/integration/consumer-role.test.ts), [sqs-consumer-inbox.test.ts](../test/integration/sqs-consumer-inbox.test.ts) |
| **RF-MSG-03** `ack` somente após o commit | T-041, T-046 | TST-C-05: [multi-instance-consumer-crash.test.ts](../test/concurrency/multi-instance-consumer-crash.test.ts) |
| **RF-MSG-04** Classificação: negócio (ack), transitório (backoff via visibilidade), permanente (DLQ imediata) | T-041, T-042a, T-042b | TST-I-12: [consumer-role.test.ts](../test/integration/consumer-role.test.ts), [sqs-consumer-dlq.test.ts](../test/integration/sqs-consumer-dlq.test.ts)<br>TST-U-11: [classify-message-error.test.ts](../test/unit/wagering/classify-message-error.test.ts), [wager-transaction-message.test.ts](../test/unit/wagering/wager-transaction-message.test.ts) |
| **RF-MSG-05** Esgotadas as tentativas (`ApproximateReceiveCount >= 8`): consumidor grava `FAILED`, envia à DLQ e apaga | T-042b | TST-I-12: [consumer-role.test.ts](../test/integration/consumer-role.test.ts), [sqs-consumer-dlq.test.ts](../test/integration/sqs-consumer-dlq.test.ts) |
| **RF-MSG-06** `SIGTERM`: conclui em andamento ou devolve a visibilidade | T-053 | TST-I-18: [shutdown.test.ts](../test/integration/shutdown.test.ts), [sqs-consumer-shutdown.test.ts](../test/integration/sqs-consumer-shutdown.test.ts) |
| **RF-MSG-07** Circuit breaker: queda do banco não leva mensagens à DLQ | T-044 | TST-I-20: [consumer-breaker.test.ts](../test/integration/consumer-breaker.test.ts) |
| **RF-MSG-08** Mesma wallet no mesmo lote: processamento em série; falha transitória devolve as seguintes do grupo; falha permanente não bloqueia as seguintes | T-041, T-042b | TST-I-12: [consumer-role.test.ts](../test/integration/consumer-role.test.ts), [sqs-consumer-dlq.test.ts](../test/integration/sqs-consumer-dlq.test.ts) |

### 10. API, reconciliação, observabilidade, autenticação

| Requisito | Tarefas | Testes → arquivos |
|---|---|---|
| **RF-API-01** Endpoints: `POST /wallets`, `GET /wallets/:id`, `GET /wallets/:id/ledger`, `GET /wagering/transactions/:id`, `GET /providers/:p/wagering/transactions/:e`, `POST /wagering/transactions`, `POST /wallets/:id/reconciliation`, `GET /health/live`, `GET /health/ready`, `GET /metrics` | T-031a, T-033 | TST-I-06: [submit-wager-transaction.test.ts](../test/integration/submit-wager-transaction.test.ts), [wagering-http.test.ts](../test/integration/wagering-http.test.ts) |
| **RF-API-02** Status HTTP distingue payload inválido, conflito de idempotência, rejeição de negócio, aceite pendente e falha transitória, de forma consistente | T-031a, T-031b, T-033 | TST-I-06: [submit-wager-transaction.test.ts](../test/integration/submit-wager-transaction.test.ts), [wagering-http.test.ts](../test/integration/wagering-http.test.ts)<br>TST-I-07: [submit-idempotency.test.ts](../test/integration/submit-idempotency.test.ts), [wagering-http.test.ts](../test/integration/wagering-http.test.ts) |
| **RF-API-03** Erros em `application/problem+json` com `errorCode` | T-031a, T-033 | TST-I-06: [submit-wager-transaction.test.ts](../test/integration/submit-wager-transaction.test.ts), [wagering-http.test.ts](../test/integration/wagering-http.test.ts) |
| **RF-API-04** Validação Zod única para HTTP e SQS | T-033, T-042a | TST-I-11: [consumer-role.test.ts](../test/integration/consumer-role.test.ts), [sqs-consumer-inbox.test.ts](../test/integration/sqs-consumer-inbox.test.ts) |
| **RF-REC-01** Reconciliação lê saldo e ledger do mesmo snapshot (`REPEATABLE READ READ ONLY`, sem locks) | T-025b, T-035 | TST-I-14: [ledger-integrity.test.ts](../test/integration/ledger-integrity.test.ts), [reconciliation-http.test.ts](../test/integration/reconciliation-http.test.ts), [repositories.test.ts](../test/integration/repositories.test.ts), [transaction-manager.test.ts](../test/integration/transaction-manager.test.ts) |
| **RF-REC-02** Divergência é logada, contada em métrica e sinalizada; nunca corrigida em silêncio | T-025b, T-035 | TST-I-14: [ledger-integrity.test.ts](../test/integration/ledger-integrity.test.ts), [reconciliation-http.test.ts](../test/integration/reconciliation-http.test.ts), [repositories.test.ts](../test/integration/repositories.test.ts), [transaction-manager.test.ts](../test/integration/transaction-manager.test.ts) |
| **RF-REC-03** Verifica continuidade da cadeia (cada `balance_before` = `balance_after` anterior; versões sem buracos) | T-025b, T-035 | TST-I-14: [ledger-integrity.test.ts](../test/integration/ledger-integrity.test.ts), [reconciliation-http.test.ts](../test/integration/reconciliation-http.test.ts), [repositories.test.ts](../test/integration/repositories.test.ts), [transaction-manager.test.ts](../test/integration/transaction-manager.test.ts) |
| **RF-OBS-01** Logs JSON com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` | T-050, T-051 | TST-I-17: [health.test.ts](../test/integration/health.test.ts), [metrics.test.ts](../test/integration/metrics.test.ts), [observability.test.ts](../test/integration/observability.test.ts) |
| **RF-OBS-02** Sem valores monetários, saldos, corpo de payload, `playerId` ou `roundId` nos logs | T-050 | TST-U-12: [log-redaction.test.ts](../test/unit/platform/log-redaction.test.ts) |
| **RF-OBS-03** Métricas mínimas do enunciado (04/03 listam os nomes) | T-050, T-051 | TST-I-17: [health.test.ts](../test/integration/health.test.ts), [metrics.test.ts](../test/integration/metrics.test.ts), [observability.test.ts](../test/integration/observability.test.ts) |
| **RF-OBS-04** `live` sem dependências; `ready` testa Postgres e SQS (timeout 2 s) e falha durante shutdown/breaker aberto/fila inexistente | T-052 | TST-I-16: [health.test.ts](../test/integration/health.test.ts) |
| **RF-AUT-01** Autenticação não implementada: `AuthGuard` no-op + `ProviderIdentityPort`, desenho documentado | T-054 | revisão: `AuthGuard` no-op e `ProviderIdentityPort` (ADR-0017); health e `/metrics` abertos (sem TST) |

### 11. Não funcionais

| Requisito | Tarefas | Testes → arquivos |
|---|---|---|
| **RNF-01** TypeScript estrito (`strict`, `noUncheckedIndexedAccess`) | T-001 | `bun run typecheck` (tsc estrito, `noUncheckedIndexedAccess`) (sem TST) |
| **RNF-02** Migrations versionadas e reversíveis, `down` testado com ledger populado | T-021, T-022 | TST-I-01: [migrations.test.ts](../test/integration/migrations.test.ts) |
| **RNF-03** `docker compose up` sobe Postgres, SQS emulado e 3 instâncias | T-005a, T-005b | `docker compose up --build` e `bun run compose:smoke` (3 instâncias, exit 0) (sem TST) |
| **RNF-04** Cabe em 8 GB de RAM | T-005a, T-005b | medição de RAM em specs/adr/0002-spike.md (R-06) (sem TST) |
| **RNF-05** Conventional Commits; um commit por tarefa | — | commitlint no hook `commit-msg` (um commit por tarefa) (sem TST) |
| **RNF-06** `README.md` (setup e comandos) e `ARCHITECTURE.md` (decisões, trade-offs, limitações) | — | `scripts/check-readme-commands.ts` e `scripts/check-architecture.ts` (sem TST) |

## Teste → arquivos

| Teste | Arquivos |
|---|---|
| TST-C-01 | [consumer-idempotency.test.ts](../test/concurrency/consumer-idempotency.test.ts), [funds-and-idempotency.test.ts](../test/concurrency/funds-and-idempotency.test.ts) |
| TST-C-02 | [funds-and-idempotency.test.ts](../test/concurrency/funds-and-idempotency.test.ts) |
| TST-C-03 | [locking.test.ts](../test/concurrency/locking.test.ts) |
| TST-C-04 | [multi-instance-load.test.ts](../test/concurrency/multi-instance-load.test.ts) |
| TST-C-05 | [multi-instance-consumer-crash.test.ts](../test/concurrency/multi-instance-consumer-crash.test.ts) |
| TST-C-06 | [multi-instance-publisher-crash.test.ts](../test/concurrency/multi-instance-publisher-crash.test.ts), [outbox-publishers.test.ts](../test/concurrency/outbox-publishers.test.ts) |
| TST-C-07 | [pending-worker.test.ts](../test/concurrency/pending-worker.test.ts) |
| TST-C-08 | [multi-instance-restart.test.ts](../test/concurrency/multi-instance-restart.test.ts) |
| TST-C-09 | [locking.test.ts](../test/concurrency/locking.test.ts) |
| TST-C-10 | [multi-instance-mixed-load.test.ts](../test/concurrency/multi-instance-mixed-load.test.ts) |
| TST-C-11 | [locking.test.ts](../test/concurrency/locking.test.ts) |
| TST-C-12 | [funds-and-idempotency.test.ts](../test/concurrency/funds-and-idempotency.test.ts) |
| TST-I-01 | [migrations.test.ts](../test/integration/migrations.test.ts) |
| TST-I-02 | [ledger-constraints.test.ts](../test/integration/ledger-constraints.test.ts), [messaging-schema.test.ts](../test/integration/messaging-schema.test.ts), [schema-constraints.test.ts](../test/integration/schema-constraints.test.ts) |
| TST-I-03 | [ledger-constraints.test.ts](../test/integration/ledger-constraints.test.ts) |
| TST-I-04 | [wager-transactions-guard.test.ts](../test/integration/wager-transactions-guard.test.ts) |
| TST-I-05 | [submit-wager-transaction.test.ts](../test/integration/submit-wager-transaction.test.ts) |
| TST-I-06 | [submit-wager-transaction.test.ts](../test/integration/submit-wager-transaction.test.ts), [wagering-http.test.ts](../test/integration/wagering-http.test.ts) |
| TST-I-07 | [submit-idempotency.test.ts](../test/integration/submit-idempotency.test.ts), [wagering-http.test.ts](../test/integration/wagering-http.test.ts) |
| TST-I-08 | [submit-references.test.ts](../test/integration/submit-references.test.ts) |
| TST-I-09 | [submit-references.test.ts](../test/integration/submit-references.test.ts) |
| TST-I-10 | [pending-worker-role.test.ts](../test/integration/pending-worker-role.test.ts), [pending-worker.test.ts](../test/integration/pending-worker.test.ts) |
| TST-I-11 | [consumer-role.test.ts](../test/integration/consumer-role.test.ts), [sqs-consumer-inbox.test.ts](../test/integration/sqs-consumer-inbox.test.ts) |
| TST-I-12 | [consumer-role.test.ts](../test/integration/consumer-role.test.ts), [sqs-consumer-dlq.test.ts](../test/integration/sqs-consumer-dlq.test.ts) |
| TST-I-13 | [outbox-publisher.test.ts](../test/integration/outbox-publisher.test.ts), [outbox-role.test.ts](../test/integration/outbox-role.test.ts) |
| TST-I-14 | [ledger-integrity.test.ts](../test/integration/ledger-integrity.test.ts), [reconciliation-http.test.ts](../test/integration/reconciliation-http.test.ts), [repositories.test.ts](../test/integration/repositories.test.ts), [transaction-manager.test.ts](../test/integration/transaction-manager.test.ts) |
| TST-I-15 | [queries-http.test.ts](../test/integration/queries-http.test.ts) |
| TST-I-16 | [health.test.ts](../test/integration/health.test.ts) |
| TST-I-17 | [health.test.ts](../test/integration/health.test.ts), [metrics.test.ts](../test/integration/metrics.test.ts), [observability.test.ts](../test/integration/observability.test.ts) |
| TST-I-18 | [shutdown.test.ts](../test/integration/shutdown.test.ts), [sqs-consumer-shutdown.test.ts](../test/integration/sqs-consumer-shutdown.test.ts) |
| TST-I-19 | [problem-details.test.ts](../test/integration/problem-details.test.ts), [wallet-creation.test.ts](../test/integration/wallet-creation.test.ts) |
| TST-I-20 | [consumer-breaker.test.ts](../test/integration/consumer-breaker.test.ts) |
| TST-U-01 | [money.test.ts](../test/unit/shared/money.test.ts) |
| TST-U-02 | [money.test.ts](../test/unit/shared/money.test.ts) |
| TST-U-03 | [wallet.test.ts](../test/unit/wallet/wallet.test.ts) |
| TST-U-04 | [wager-transaction.test.ts](../test/unit/wagering/wager-transaction.test.ts) |
| TST-U-05 | [transaction-policy.test.ts](../test/unit/wagering/transaction-policy.test.ts), [wager-transaction.test.ts](../test/unit/wagering/wager-transaction.test.ts) |
| TST-U-06 | [hash.test.ts](../test/unit/shared/hash.test.ts), [payload-hash.test.ts](../test/unit/wagering/payload-hash.test.ts) |
| TST-U-07 | [wallet-ledger-entry.test.ts](../test/unit/wallet/wallet-ledger-entry.test.ts) |
| TST-U-08 | [inbox-outbox.test.ts](../test/unit/messaging/inbox-outbox.test.ts) |
| TST-U-09 | [integration-events.test.ts](../test/unit/messaging/integration-events.test.ts) |
| TST-U-10 | [reference-backoff.test.ts](../test/unit/wagering/reference-backoff.test.ts) |
| TST-U-11 | [classify-message-error.test.ts](../test/unit/wagering/classify-message-error.test.ts), [wager-transaction-message.test.ts](../test/unit/wagering/wager-transaction-message.test.ts) |
| TST-U-12 | [log-redaction.test.ts](../test/unit/platform/log-redaction.test.ts) |
| TST-U-13 | [architecture.test.ts](../test/unit/architecture.test.ts) |

## Tarefas

- [x] **T-001** Scaffold: Bun + TypeScript estrito (`noUncheckedIndexedAccess`), estrutura `src/` e `test/`, scripts, `.gitignore`, `.editorconfig`. *(RNF-01, ADR-0020)*
- [x] **T-002** Spike R-02: Nest + MikroORM (+ `@mikro-orm/nestjs`) sobem no Bun; DI com `emitDecoratorMetadata`; `em.transactional`; `LockMode` (`FOR UPDATE`, `SKIP LOCKED`); migrator `up/down`. Registrar a versão em `adr/0002-spike.md`. *(ADR-0002)*
- [x] **T-003** Spike R-01/R-03: emulador SQS **sem token** (LocalStack fixado em tag anterior a 2026.03, ou MiniStack); validar FIFO, `MessageGroupId`, dedup, DLQ FIFO com redrive, `ChangeMessageVisibility`; AWS SDK v3 no Bun. **Se nenhum funcionar: parar e consultar o autor.**
- [x] **T-004** Spike R-04/R-05: `prom-client` (counter, gauge, histogram, `/metrics`) no Bun; Biome (`noFloatingPromises`, `useImportType` desligado); commitlint + hook sem Husky global.
- [x] **T-005a** `docker-compose.yml` e `docker-compose.test.yml` **somente com Postgres e emulador SQS**; script idempotente de criação de filas; medir a RAM dessa base (R-06). *(RNF-03, RNF-04)*
- [x] **T-005b** *(executada na onda W10, depois que o app sobe)* `Dockerfile` e serviços `app1..3` no `docker-compose.yml`; `docker compose up --build` sobe tudo; medir a RAM completa (R-06). *(RNF-03, RNF-04)*
- [x] **T-006** `CLAUDE.md` com comandos reais e Biome/commitlint ativos; este arquivo atualizado com os resultados do spike.
- [x] **T-010** `Money` (big.js, escala 2, parse estrito) + erros de domínio. *(RF-MNY-01..04; TST-U-01, U-02)*
- [x] **T-011** `Wallet` (`open`, `rehydrate`, `debit`, `credit`, `version`) + `WalletLedgerEntry`. *(RF-WAL-03/04, RF-LED-03; TST-U-03, U-07)*
- [x] **T-012** `WagerTransaction` (estados, transições, `ledgerDirectionFor`, `matchesPayload`). *(RF-TXN-01; TST-U-04, U-05)*
- [x] **T-013** `payloadHash` canônico e `IdempotencyKey`. *(RF-IDP-05; TST-U-06)*
- [x] **T-014** `InboxMessage`, `OutboxMessage` (backoff, `isDue`), `IntegrationEvent` + 5 eventos. *(RF-OUT-07; TST-U-08, U-09)*
- [x] **T-015** Políticas de referência/reversão (puras): kind permitido, mismatch, valor, já revertida, `PENDING_REFERENCE`. *(RF-TXN-06..09, 11; TST-U-05)*
- [x] **T-016** Teste de arquitetura de imports. *(RF-MNY-05; TST-U-13)*
- [x] **T-020** Config Zod do ambiente + módulo de infraestrutura (MikroORM, pool, timeouts). *(02-design §8)*
- [x] **T-021** Migration 1: `wallets`, `wager_transactions` (constraints, índice parcial de reversão, índices). *(RF-WAL-01, RF-IDP-04/06, RF-TXN-13; TST-I-01, I-02)*
- [x] **T-022** Migration 2: `wallet_ledger_entries` + triggers de imutabilidade + trigger de `wager_transactions`; `down` seguro. *(RF-LED-*, RF-TXN-01; TST-I-01, I-03, I-04)*
- [x] **T-023** Migration 3: `inbox_messages`, `outbox_messages`. *(RF-OUT-*, RF-MSG-02)*
- [x] **T-024** EntitySchemas + mappers + repositórios (wallet com `FOR UPDATE`, transação, ledger, inbox, outbox). *(ADR-0004)*
- [x] **T-025a** *(antes de T-021)* Infra de teste: banco template migrado uma vez, `createSuiteDatabase`, filas por suíte (com DLQ e redrive), `eventually`. *(05-test-plan §2)*
- [x] **T-025b** *(depois de T-024)* `assertLedgerInvariant`: leitura SQL em snapshot em `wallet/infrastructure`, **a mesma função** que T-035 reaproveita na reconciliação; confere `balance = Σ ledger`, cadeia contínua, saldo ≥ 0, `version` coerente. *(ADR-0016, ADR-0019; TST-I-14 parcial)*
- [x] **T-026** *(depois de T-025b)* Bootstrap Nest: `main.ts`, `AppModule` com módulos por papel, flags `ENABLE_*`, `enableShutdownHooks` (esqueleto). Teste: smoke de boot em integração (cada combinação de flags sobe e para). *(ADR-0003, 02-design §1 e §8)*
- [x] **T-030** `CreateWallet` + `GET /wallets/:id` + OPENING/ledger/evento. *(RF-WAL-01/02; TST-I-19)*
- [x] **T-031a** `SubmitWagerTransaction` — pipeline financeiro: ordem canônica (lock da wallet → `INSERT … ON CONFLICT DO NOTHING` → aplicar), `BET/WIN/LOSS`, `REJECTED` (saldo, player, moeda), ledger, `observed_balance`, outbox. Canal HTTP; o ramo SQS/inbox entra em T-042a. *(RF-TXN-03..05/10, RF-OUT-01; TST-I-05, TST-I-06 no nível do caso de uso)*
- [x] **T-031b** `SubmitWagerTransaction` — idempotência: fast path sem lock, replay com saldo observado, `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`, `EXTERNAL_TRANSACTION_ID_CONFLICT`. *(RF-IDP-01..06; TST-I-07 no nível do caso de uso)*
- [x] **T-032** Reversões e validação de referência (`REFUND`, `ROLLBACK`, `PENDING_REFERENCE` na entrada). *(RF-TXN-06..09/11/13; TST-I-08, I-09)*
- [x] **T-033** Controllers, Zod, problem+json, mapeamento de status, `X-Correlation-Id`. *(RF-API-*)*
- [x] **T-034** Consultas: transação por id e por (provider, external id); ledger paginado. *(RF-LED-04; TST-I-15)*
- [x] **T-035** Reconciliação (snapshot, cadeia). *(RF-REC-*; TST-I-14)*
- [x] **T-036** Testes de concorrência da fase: C-01, C-02, C-03, C-09, C-11, C-12. *(RF-CON-*)*
- [x] **T-040** Publisher da outbox (`SKIP LOCKED`, lote, backoff, `publish_failed`, métricas de lag). *(RF-OUT-*; TST-I-13, C-06)*
- [x] **T-041** Porta `MessageConsumer` + poller SQS (grupos em série, concorrência entre grupos, visibilidade, timeout). *(RF-MSG-01..04/08)*
- [x] **T-042a** Inbox (ramo SQS do caso de uso, antes do lock da wallet) + classificação de erros (negócio/transitório/infra/permanente). *(RF-MSG-01/02/04, RF-IDP-07; TST-U-11, TST-I-11)*
- [x] **T-042b** DLQ explícita para permanentes + exaustão (`ApproximateReceiveCount >= 8` → `FAILED` + DLQ + delete). *(RF-MSG-04/05/08; TST-I-12)*
- [x] **T-043** Worker de `PENDING_REFERENCE` (ordem wallet→linha, revalidação, acordar dependentes). *(RF-REF-*; TST-I-10, C-07)*
- [x] **T-044** Circuit breaker de infraestrutura. *(RF-MSG-07; TST-I-20)*
- [x] **T-045** Seam de falha (`TEST_FAULT`) com recusa em produção. *(03-messaging §9)*
- [x] **T-046** Testes multi-processo: C-04, C-05, C-08, C-10 + `Bun.spawn` de instâncias.
- [x] **T-050** Logs pino + contexto AsyncLocalStorage + `redact`. *(RF-OBS-01/02; TST-U-12, I-17)*
- [x] **T-051** Métricas Prometheus e `GET /metrics`. *(RF-OBS-03; TST-I-17)*
- [x] **T-052** Health `live`/`ready`. *(RF-OBS-04; TST-I-16)*
- [x] **T-053** Shutdown ordenado (`SIGTERM`) e `stop_grace_period`. *(RF-MSG-06; TST-I-18)*
- [x] **T-054** `AuthGuard` no-op + `ProviderIdentityPort`. *(RF-AUT-01)*
- [x] **T-060** `README.md` (setup, comandos, como rodar 3 instâncias, como rodar testes, declaração de uso de IA/SDD).
- [x] **T-061** `ARCHITECTURE.md` (curado a partir dos ADRs: decisões, trade-offs, limitações, ordem de locks, interpretações, taxonomia de falhas, status HTTP).
- [x] **T-062** Revisão de rastreabilidade: matriz requisito → tarefa → teste sem buracos; `study-guide.md` atualizado com o que mudou na implementação.
- [x] **T-063** Passada final: suíte completa 3× seguidas (flakiness), cobertura, `docker compose up` do zero.

## Não implementado, documentado (stretch)

Fora do escopo obrigatório; nenhum requisito RF/RNF depende destas tarefas. A linha de corte (M4) não foi usada: todas as tarefas T, inclusive a T-044, estão concluídas.

- **S-01** `bun run test:load` com metodologia, p50/p95/p99, taxa de erro, conflitos de lock, outbox lag; comparar estratégia A (pessimista) com C (`UPDATE` condicionado) em 50 concorrentes. — não implementado, documentado
- **S-02** Constraint trigger `DEFERRABLE INITIALLY DEFERRED` de consistência saldo×ledger. — não implementado, documentado
- **S-03** IdP real (Keycloak/Zitadel) atrás do `ProviderIdentityPort`. — não implementado, documentado
- **S-04** Swagger/OpenAPI a partir dos schemas Zod. — não implementado, documentado
- **S-05** Partidas dobradas. — não implementado, documentado
- **S-06** OpenTelemetry. — não implementado, documentado
