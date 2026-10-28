# ADR-0018 — Observabilidade

- **Status:** Aceita (prom-client condicionado ao spike) · **Data:** 2026-10-27 · **Relacionados:** RF-OBS-*

## Decisão
**Logs:** JSON com `pino` (`nestjs-pino`) e contexto por requisição/mensagem em `AsyncLocalStorage`. Permitidos: `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, `kind`, `status`, `failureCode`, `errorCode`, `durationMs`, `channel`. **Proibidos:** valores monetários, saldos, corpo do payload, `playerId` e `roundId` (P-1: identificadores de pessoa/jogo; o diagnóstico usa `transactionId`/`walletId`). `redact` do pino + teste (TST-U-12).

**Correlação:** HTTP usa `X-Correlation-Id` (gerado se ausente); SQS usa o `messageId`; os eventos da outbox carregam `correlationId` e `causationId` (= id da transação que causou o evento; sem causação encadeada, P-2).

**Métricas:** `prom-client` com `GET /metrics` aberto: transações por status/kind/canal, duplicatas (replay/conflito), retries, DLQ, conflitos de lock, lag da outbox (gauge), latência (histograma), divergências de reconciliação, breaker. **Sem `walletId` como label** (cardinalidade). O spike valida histograma e `/metrics`, não só as métricas padrão do Node.

**Health:** `live` sem dependências; `ready` com `SELECT 1` e `GetQueueAttributes` das filas (timeout 2 s), falhando também com breaker aberto, fila inexistente e durante o shutdown. Implementação própria, sem `@nestjs/terminus`.

OpenTelemetry é opcional (S-06).

## Consequências
- (+) Diagnóstico sem expor dado sensível. (−) Sem tracing distribuído (correlação por id).
