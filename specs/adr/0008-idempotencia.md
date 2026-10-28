# ADR-0008 — Idempotência persistente

- **Status:** Aceita · **Data:** 2026-10-27 · **Relacionados:** RF-IDP-*

## Contexto
Entrega at-least-once; o mesmo pedido chega por HTTP ou SQS, várias vezes e em paralelo. A resposta de replay deve ser a original, **incluindo o saldo observado naquele momento** (que não está no ledger para `LOSS` e `REJECTED`).

## Opções consideradas
| Opção | Trade-off |
|---|---|
| **A. Colunas na própria `wager_transactions`: `idempotency_key`, `payload_hash`, `observed_balance`** | Uma fonte da verdade; sem sincronizar tabelas |
| B. Tabela `idempotency_keys` separada com a resposta serializada | Genérica, mas duplica estado e exige atomicidade entre duas tabelas |

## Decisão
**A**, com:
- `UNIQUE (provider_id, idempotency_key)` — a chave tem escopo por provedor.
- `UNIQUE (provider_id, external_transaction_id)` — necessário para resolver referências sem ambiguidade; mesmo id externo com outra chave → 409 `EXTERNAL_TRANSACTION_ID_CONFLICT`.
- `payloadHash` = SHA-256 do JSON canônico dos campos de negócio (04-api §6). Header, `messageId` e metadados ficam fora.
- Duas camadas de deduplicação: o **inbox** descarta a mesma mensagem SQS reentregue; a **chave de idempotência** descarta a mesma operação em mensagens ou canais diferentes. HTTP e SQS compartilham o espaço de chaves.
- Replay devolve o estado atual (terminal é imutável) com `observed_balance` gravado.

## Consequências
- (+) Dedup no banco, correto com N instâncias e após reinício; sem cache.
- (−) Uma consulta extra por requisição (fast path) e linhas de rejeição também ocupam a chave (intencional: auditoria).
