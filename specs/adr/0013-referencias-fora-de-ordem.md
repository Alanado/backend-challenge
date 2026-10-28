# ADR-0013 — Referências fora de ordem (`PENDING_REFERENCE`)

- **Status:** Aceita · **Data:** 2026-10-27 · **Relacionados:** RF-REF-*

## Contexto
Uma operação dependente (`REFUND`, `ROLLBACK`, ou `WIN`/`LOSS` com referência) pode chegar antes da transação referenciada. O enunciado pede worker agendado com backoff, limite justificado e `REJECTED` ao esgotar, com evento.

## Decisão
- Referência ausente → `PENDING_REFERENCE` (HTTP 202) + evento `WagerTransactionPendingReference` (uma vez).
- **Backoff:** 6 tentativas, base 5 s, fator 2, jitter igual (`d/2 + rand(d/2)`), teto 300 s ⇒ ≈ 5 min no total. Referências fora de ordem costumam chegar em segundos; 5 minutos cobrem atraso de fila sem deixar pendências por horas. Configurável; nos testes, milissegundos.
- Esgotado → `REJECTED` `REFERENCE_NOT_FOUND` + `WagerTransactionRejected`.
- **Resolução por (`providerId`, `externalTransactionId`) sem filtro de wallet**, verificando a wallet depois: uma `BET` de outra wallet gera `REFERENCE_MISMATCH` (terminal), em vez de `REFERENCE_NOT_FOUND` após todas as tentativas.
- Referência `PENDING_REFERENCE` → esta também fica pendente (cadeia); `REJECTED`/`FAILED` → `REFERENCE_NOT_PROCESSED`.
- **Acordar dependentes:** ao processar uma transação, `UPDATE … SET next_attempt_at = now()` nos pendentes que a referenciam, **só da mesma wallet** travada, na mesma transação. Dependentes de outras wallets esperam o backoff e serão rejeitadas por mismatch.
- **Worker** (a cada 1 s, concorrência 5 entre wallets): leitura sem lock dos candidatos → por candidato, em transação própria: `FOR UPDATE` da wallet → relê a transação com `FOR UPDATE` e **revalida** (status e vencimento). Não usa `SKIP LOCKED` na linha primeiro: inverteria a ordem de locks (ADR-0007). A revalidação cobre dois workers concorrentes.

## Consequências
- (+) Corrige a desordem sem perder eventos; sem ciclos de lock. (−) Pendentes de uma mesma wallet quente competem pelo lock; aceitável.
