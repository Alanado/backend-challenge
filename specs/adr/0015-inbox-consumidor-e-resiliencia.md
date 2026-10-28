# ADR-0015 — Inbox, consumidor SQS, DLQ, circuit breaker e shutdown

- **Status:** Aceita (poller condicionado ao spike do AWS SDK no Bun) · **Data:** 2026-10-27 · **Relacionados:** RF-MSG-*

## Contexto
Consumidor deve reutilizar o caso de uso HTTP, deduplicar por inbox persistente, fazer ack só após o commit, distinguir erros (negócio/transitório/permanente), respeitar limite de tentativas, tratar `SIGTERM` e suportar redelivery. Em FIFO, uma mensagem em voo bloqueia as seguintes do mesmo grupo.

## Decisão
**Inbox** `(consumer_name, message_id)` na mesma transação do efeito, **antes** do lock da wallet (sem FK, sem `KEY SHARE`); duplicata espera a primeira sem segurar locks. Mesmo `messageId` com `payload_hash` diferente → DLQ.

**Classificação:** negócio → ack; transitório da mensagem (`55P03`, `40P01`, `57014`) → backoff via `ChangeMessageVisibility` (2 s·2^n, teto 30 s); infraestrutura → breaker; permanente → DLQ imediata.

**DLQ:**
| Opção | Trade-off |
|---|---|
| A. Só `redrivePolicy` | Erro permanente tentado N vezes; bloqueia a wallet no FIFO |
| **B. Explícita para permanentes + redrive como rede de segurança (escolhida)** | Permanente sai na hora; exaustão tratada pelo código |

Na exaustão (`ApproximateReceiveCount >= 8`) o **consumidor** grava `FAILED`, envia à DLQ e apaga; o redrive só cobre quedas do processo. Envio à DLQ e delete não são atômicos (duplicata na DLQ aceita e documentada).

**Poller próprio** fino sobre `@aws-sdk/client-sqs`, atrás da porta `MessageConsumer` (controle do ack pós-commit, backoff por mensagem, shutdown; alternativa: biblioteca como `sqs-consumer`, não validada no Bun). Concorrência de 5 handlers **entre grupos**; mesmo grupo em série; falha transitória devolve as seguintes do grupo; falha permanente não bloqueia as seguintes. Handler com timeout de 20 s < visibilidade de 30 s.

**Circuit breaker de infraestrutura:** erro de conexão/pool/rede abre o breaker; o consumidor para de buscar (mensagem não recebida não consome tentativa), cooldown exponencial 1–30 s, retoma com `SELECT 1`. `maxReceiveCount = 8` fica para erros da própria mensagem. Readiness falha com o breaker aberto. Prova: banco derrubado → zero mensagens na DLQ (TST-I-20).

**Shutdown:** readiness falha → para de buscar → espera handlers (20 s) → devolve os restantes com visibilidade 0 → publisher termina o lote → fecha o pool; `stop_grace_period: 30s`. Se o handler já tinha feito commit sem ack, a devolução gera redelivery que o inbox descarta.

## Consequências
- (+) Uma queda de banco não leva mensagens válidas à DLQ. (−) Mais código no consumidor; `FAILED` é best-effort sem banco.
