# 03 — Mensageria

Cobre: outbox + publishers, inbox + consumidor SQS, DLQ, worker de `PENDING_REFERENCE`, shutdown, circuit breaker e catálogo de eventos. Decisões: ADR-0013, ADR-0014, ADR-0015.

## 1. Filas

| Fila | Tipo | Papel |
|---|---|---|
| `wager-transactions.fifo` | FIFO | Entrada: `WagerTransactionRequested`. Visibilidade 30 s, long polling 20 s, redrive `maxReceiveCount=8` |
| `wager-transactions-dlq.fifo` | FIFO | DLQ (precisa ser FIFO por exigir o par FIFO) |
| `wager-events.fifo` | FIFO | Saída: eventos de integração. `MessageGroupId = walletId`, `MessageDeduplicationId = eventId` |

**FIFO é otimização, não garantia.** A deduplicação e a consistência vêm do banco (inbox, idempotência, constraints).
A entrada assume `MessageGroupId = walletId` (o produtor de teste faz isso); a correção **não depende** disso, pois o lock da wallet serializa.

## 2. Mensagem de entrada

Envelope do enunciado (§10): `messageId`, `type = "WagerTransactionRequested"`, `occurredAt`, `data{providerId, externalTransactionId, idempotencyKey, playerId, walletId, roundId, gameId, kind, money{amount,currency}, referenceExternalTransactionId?}`. Validado pelo **mesmo schema Zod** do HTTP (mais o envelope). `inbox.payload_hash` = SHA-256 do JSON canônico do corpo inteiro da mensagem.

## 3. Consumidor SQS

### 3.1 Fluxo por mensagem

1. Validar JSON e schema; erro → **permanente**.
2. Executar `SubmitWagerTransaction` (canal SQS): numa transação, insere o inbox `(consumer_name = 'wager-transactions-consumer', message_id)`; se já existe → ack sem processar (e se o `payload_hash` diverge → DLQ); depois o fluxo financeiro (02-design §5); marca o inbox como processado; commit.
3. **Ack (delete) só depois do commit.**

### 3.2 Classificação de erros

| Tipo | Exemplos | Ação |
|---|---|---|
| **Resultado de negócio** | `PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, replay, duplicata de inbox | Ack |
| **Transitório (da mensagem)** | `lock_timeout` (55P03), deadlock (40P01), `statement_timeout` (57014) | Não apaga. `ChangeMessageVisibility = min(cap, base·2^(receiveCount−1))` (base 2 s, teto 30 s) |
| **Infraestrutura** | Conexão recusada, pool esgotado, timeout de rede do SQS | Aciona o **circuit breaker** (§5); a mensagem volta com visibilidade 0 |
| **Permanente** | JSON inválido, schema inválido, `type` desconhecido, `kind = OPENING`, mesmo `messageId` com corpo diferente, wallet inexistente | DLQ imediata (com atributos `errorCode`/`reason`), depois delete |

### 3.3 Exaustão e DLQ

- Quando `ApproximateReceiveCount >= SQS_MAX_RECEIVE (8)` e a falha persiste: **o consumidor** grava `FAILED` (`PROCESSING_ATTEMPTS_EXHAUSTED`) em transação própria (se o payload for válido e o banco responder), envia à DLQ e apaga. O redrive do SQS é só rede de segurança para quedas do processo.
- DLQ FIFO exige `MessageGroupId` e `MessageDeduplicationId`: reaproveita os da mensagem original.
- **Limitações documentadas:** o envio à DLQ seguido do delete não é atômico (uma queda entre os dois duplica na DLQ); sem banco não há `FAILED` nem evento, e a DLQ é a fonte de verdade.
- **`FAILED` é definitivo:** replay devolve `FAILED`. Para tentar de novo, o provedor envia uma **nova** transação (novo `externalTransactionId` e nova chave).

### 3.4 Poller (ADR-0015)

Poller próprio e fino sobre `@aws-sdk/client-sqs`, atrás da porta `MessageConsumer` (permite trocar a implementação e testar). `ReceiveMessage`: `MaxNumberOfMessages=10`, `WaitTimeSeconds=20`, atributos `ApproximateReceiveCount` e `MessageGroupId`. Mensagens do lote são **agrupadas por `MessageGroupId`**:

- grupos diferentes → concorrência de até `SQS_CONCURRENCY` (5) handlers;
- mesmo grupo → **em série**, na ordem recebida;
- falha **transitória** em uma mensagem → as seguintes do mesmo grupo no lote são devolvidas (`ChangeMessageVisibility = 0`), sem processar;
- falha **permanente** → DLQ imediata e as seguintes seguem normalmente.

Cada handler tem timeout de 20 s (< visibilidade de 30 s). Por que isso importa no FIFO: enquanto uma mensagem de um grupo está em voo, o SQS não entrega as seguintes do mesmo grupo (bloqueio de cabeça de fila); por isso o erro permanente sai do caminho na hora.

## 4. Worker de `PENDING_REFERENCE` (ADR-0013)

A cada `PENDING_REF_POLL_MS`:
1. Leitura **sem lock** dos candidatos: `status='PENDING_REFERENCE' AND next_attempt_at <= now()` (limite).
2. Para cada candidato (concorrência entre wallets limitada a 5), em transação própria: `FOR UPDATE` da wallet → relê a transação com `FOR UPDATE` e **revalida** (ainda `PENDING_REFERENCE` e vencida) → tenta resolver a referência (mesma lógica do caso de uso).
   - resolveu → processa (ledger, evento `Processed` + `WalletBalanceChanged`);
   - ainda ausente → `reference_attempts + 1`, `next_attempt_at = now + delay` (backoff exponencial, jitter igual: `d/2 + rand(d/2)`);
   - divergência (mismatch, kind, referência rejeitada) → `REJECTED` com o código específico;
   - `reference_attempts >= PENDING_REF_MAX_ATTEMPTS` → `REJECTED` `REFERENCE_NOT_FOUND` + `WagerTransactionRejected`.

Por que não `SKIP LOCKED` na linha primeiro: inverteria a ordem de locks (linha antes da wallet) e abriria ciclo com o fluxo normal.

Atrasos padrão: 5, 10, 20, 40, 80, 160 s (≈ 5 min no total); teto 300 s; tudo configurável (nos testes, milissegundos).

## 5. Circuit breaker de infraestrutura (ADR-0015)

Erros de infraestrutura (conexão recusada, `57P01/57P03/08xxx`, pool esgotado, timeout de rede) **abrem o breaker**: o consumidor para de buscar mensagens (mensagem não recebida não consome tentativa), com cooldown exponencial de 1 s a 30 s, e retoma quando um `SELECT 1` passar. Readiness falha com o breaker aberto. `lock_timeout`/deadlock **não** abrem o breaker (são erros da mensagem e consomem tentativas). Prova (TST-I-20): banco derrubado durante o consumo → nenhuma mensagem na DLQ.

## 6. Outbox e publishers (ADR-0014)

### 6.1 Escrita
Na **mesma transação** do efeito financeiro, 1–3 linhas em `outbox_messages` (`id = eventId`, `group_key = walletId`, `payload` = envelope serializado, `next_attempt_at = occurred_at`).

### 6.2 Publicação (cada instância)
A cada `OUTBOX_POLL_MS`, em uma transação:
```sql
SELECT * FROM outbox_messages
 WHERE published_at IS NULL AND failed_at IS NULL AND next_attempt_at <= now()
 ORDER BY occurred_at
 LIMIT 10
 FOR UPDATE SKIP LOCKED;
```
`SendMessageBatch` (timeout 3 s) → por entrada: sucesso → `published_at = now()`; falha transitória → `attempts+1` e `next_attempt_at` (backoff exponencial, base 1 s, teto 60 s, **sem limite de tentativas**); falha permanente (mensagem acima do limite, parâmetro inválido) → `failed_at`, `last_error`, métrica e alerta. Commit.

**Garantias e limites:**
- Se o processo morre antes do commit, os locks somem e outro publisher republica: **at-least-once**. O `eventId` permanece o mesmo.
- Dois publishers podem publicar eventos da mesma wallet **fora de ordem**; a ordem no broker é a de envio. O consumidor ordena por `walletVersion`/`occurredAt`. Limitação documentada.
- Classificação dos erros do SQS: rede, throttling, 5xx e fila inexistente são **transitórios** (a readiness falha se a fila não existe e `outbox_lag_seconds` alerta); parâmetro inválido e tamanho excedido são permanentes.
- Retenção das linhas publicadas: fora de escopo.

## 7. Eventos de integração

Envelope (`IntegrationEvent<T>`, classe abstrata com subclasse por evento; `eventType` e `version` no tipo): `eventId`, `eventType`, `aggregateId`, `correlationId`, `causationId`, `occurredAt` (ISO-8601), `version`, `data` (`MoneyProps` em string decimal, nunca `Money`).

| Cenário | Eventos |
|---|---|
| `BET`/`WIN`/`REFUND`/`ROLLBACK` processados | `WagerTransactionProcessed` + `WalletBalanceChanged` |
| `LOSS` processado | `WagerTransactionProcessed` |
| Rejeição de negócio (inclui esgotamento de referência) | `WagerTransactionRejected` |
| Primeira entrada em `PENDING_REFERENCE` (uma vez) | `WagerTransactionPendingReference` |
| `PENDING_REFERENCE` resolvida | `WagerTransactionProcessed` + `WalletBalanceChanged` |
| `FAILED` gravado (opcional, extensão) | `WagerTransactionFailed` — só se o `FAILED` foi gravado |
| Replay | nenhum |
| `OPENING` (saldo inicial > 0) | `WalletBalanceChanged` apenas |

`aggregateId`: id da transação (eventos de transação) ou da wallet (`WalletBalanceChanged`). `correlationId`: o da requisição (HTTP) ou o `messageId` (SQS). `causationId`: id da transação que causou o evento (P-2).

Dados mínimos de `data`:
- `WagerTransactionProcessed|Rejected|PendingReference|Failed`: `transactionId`, `providerId`, `externalTransactionId`, `walletId`, `roundId`, `gameId`, `kind`, `money`, `referenceTransactionId?`, e conforme o caso `failureCode`, `nextAttemptAt`, `processedAt`. (`playerId` fica fora dos logs, mas pode ir no evento.)
- `WalletBalanceChanged`: `walletId`, `transactionId`, `direction`, `money`, `balanceBefore`, `balanceAfter`, `walletVersion`.

## 8. Shutdown (`SIGTERM`)

1. Readiness passa a falhar.
2. HTTP para de aceitar conexões novas e drena as em curso.
3. Consumidor para de buscar; espera os handlers por até `SHUTDOWN_GRACE_MS` (20 s).
4. Handlers que não terminaram: mensagem devolvida (`ChangeMessageVisibility = 0`), **sem apagar**. Se o handler já tinha feito commit sem ack, a mensagem volta e o inbox a descarta.
5. Publisher termina o lote atual; worker de referências conclui a transação em curso.
6. Fecha o pool. `stop_grace_period: 30s` no Compose.

## 9. Seam de injeção de falha

`TEST_FAULT` (somente testes; **recusada se `NODE_ENV=production`**, a aplicação aborta no boot): `crash-after-commit-before-ack`, `crash-after-publish-before-commit`, `fail-mid-transaction`. Torna determinísticos os cenários de morte do processo. Documentado no `ARCHITECTURE.md`.
