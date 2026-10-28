# ADR-0011 — Estados, `failureCode` × `errorCode` e o papel do `FAILED`

- **Status:** Aceita · **Data:** 2026-10-27 · **Relacionados:** RF-TXN-01/10/12, RF-MSG-05

## Contexto
O enunciado define cinco estados e pede uma taxonomia estável de `failureCode`, suficiente para o provedor decidir se reenvia, corrige o payload ou desiste.

## Decisão
**Estados:** `PENDING → PROCESSED | REJECTED | PENDING_REFERENCE | FAILED`; `PENDING_REFERENCE → PROCESSED | REJECTED | FAILED`; `PROCESSED`, `REJECTED`, `FAILED` terminais. `PENDING` é transitório dentro da transação SQL e nunca observável por fora. Nova tentativa que continua pendente não é transição (incrementa `reference_attempts`).

**Separação de catálogos:**
- `failureCode`: resultado de negócio **gravado** (`REJECTED`/`FAILED`). Quem lê sabe que a transação existe no banco e que é auditável. Cada código documenta a ação esperada do provedor (04-api §4.1).
- `errorCode`: erro **não persistido** (400, 404, 409, 503, 500).

**Rejeições são persistidas** (auditoria), inclusive divergência de player/moeda da wallet. Wallet inexistente e payload inválido **não** são persistidos (não há `wallet_id` válido / não é transação).

**`FAILED`:**
- Gravado **apenas** pelo consumidor SQS quando as tentativas se esgotam com payload válido e banco disponível. O HTTP nunca grava `FAILED` (devolve 503 e o provedor reenvia).
- Terminal e definitivo: replay devolve `FAILED`. Para tentar de novo, o provedor envia uma **nova** transação (novo `externalTransactionId` e nova chave).
- **Best-effort:** sem banco não há registro nem evento; a DLQ é a fonte de verdade (limitação documentada).
- Emite `WagerTransactionFailed` (extensão, opcional) apenas quando gravado.

**Replay segue o estado atual** (um `PENDING_REFERENCE` que virou `PROCESSED` responde 200 `PROCESSED`).

## Consequências
- (+) Provedor decide só pelo código. (−) `FAILED` sem banco é invisível ao GET (404): documentado.
