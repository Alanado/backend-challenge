# ADR-0012 — Mapeamento de status HTTP e formato de erro

- **Status:** Aceita · **Data:** 2026-10-27 · **Relacionados:** RF-API-02/03

## Contexto
A API precisa distinguir, de forma consistente em todos os endpoints: payload inválido, conflito de idempotência, rejeição de negócio, aceite pendente e falha transitória. Colapsar situações em um código obriga o provedor a interpretar mensagens para decidir se pode reenviar.

## Decisão
Regra para o provedor: **2xx = aplicou · 202 = aceito, pendente · 422 = não aplicou, definitivo · 4xx de validação/conflito = corrigir · 503 = reenviar com a mesma chave.**

| Situação | HTTP |
|---|---|
| `PROCESSED` na primeira vez / replay | 201 / 200 |
| `PENDING_REFERENCE` | 202 |
| `REJECTED` (primeira vez e replay), `FAILED` (replay) | 422 |
| Payload/header inválido | 400 |
| Conflito de idempotência, id externo reutilizado, wallet duplicada | 409 |
| Wallet/transação inexistente | 404 |
| Falha transitória (inclui `lock_timeout`, deadlock) | 503 + `Retry-After` |
| Bug | 500 |

- **422 para rejeição de negócio** (em vez de 200/201 com `status: REJECTED`): o provedor distingue "aplicou" de "não aplicou" só pelo status. Alguns clientes tratam 4xx como definitivo, o que aqui é desejável; documentado no `ARCHITECTURE.md`: **não reenviar 422 com a mesma chave**.
- O status do replay **segue o estado atual**.
- Resultados de transação (201/200/202/422) usam o envelope de resultado; erros (400/404/409/503/500) usam `application/problem+json` (RFC 9457) com `errorCode`, `correlationId` e `retryable`.
- Mesma lógica em `POST /wallets` (409 para duplicada).

## Consequências
- (+) Decisão de reenviar sem ler o corpo. (−) 422 coexistindo com o envelope de resultado exige documentação clara.
