# ADR-0010 — No máximo uma reversão por transação referenciada

- **Status:** Aceita · **Data:** 2026-10-27 · **Relacionados:** RF-TXN-13, I-7

## Contexto
Regra 4 (§7): "Uma referência não pode ser revertida duas vezes **pelo mesmo tipo** de operação." Lida ao pé da letra, uma `BET` pode receber `REFUND` (crédito) e depois `ROLLBACK` (inverso do débito, também crédito). Cenário: saldo 100,00 → `BET` 25 (75,00) → `REFUND` (100,00) → `ROLLBACK` da mesma `BET` (125,00): crédito duplicado, violando a invariante da §3 ("não pode duplicar créditos").

## Opções consideradas
- **A.** No máximo uma reversão `PROCESSED` por transação referenciada, qualquer que seja o tipo.
- B. Literal: uma por tipo (permite crédito duplo).

## Decisão
**A**, no schema:
```sql
CREATE UNIQUE INDEX wt_one_reversal_per_reference
  ON wager_transactions (reference_transaction_id)
  WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';
```
Quando a regra 4 literal e a invariante conflitam, a invariante prevalece; o enunciado (§7) pede que interpretações adicionais sejam documentadas. Casos válidos continuam válidos: `ROLLBACK` de `WIN` e de `REFUND` usam outra referência. A checagem de aplicação (`REFERENCE_ALREADY_REVERSED`) acontece com a wallet travada; o índice é a rede de segurança.

## Testes
TST-I-08 (saldo 100,00 → 75,00 → 100,00 → `ROLLBACK` `REJECTED`, saldo **100,00**), TST-C-11 (`REFUND` e `ROLLBACK` em paralelo: exatamente uma `PROCESSED`).

## Consequências
- (+) Invariante garantida pelo banco. (−) Desvio do texto literal; declarado no `ARCHITECTURE.md` com a citação da regra, o cenário e a interpretação. Se houver canal com o avaliador, vale confirmar com uma pergunta objetiva.
