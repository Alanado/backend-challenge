# ADR-0016 — Reconciliação

- **Status:** Aceita · **Data:** 2026-10-27 · **Relacionados:** RF-REC-*

## Contexto
`POST /wallets/:id/reconciliation` compara o saldo armazenado com o reconstruído pelo ledger. Divergências não são corrigidas em silêncio.

## Decisão
- **Não é uma decisão de saldo**, então está fora da regra "ler com `FOR UPDATE`". Mas os dois valores precisam vir do **mesmo snapshot**: em `READ COMMITTED`, duas leituras poderiam ver commits diferentes e reportar divergência falsa. Leitura em transação `REPEATABLE READ READ ONLY`, **sem locks** (não bloqueia wallet quente), ou cálculo em um único `SELECT`.
- `calculatedBalance = SUM(CREDIT) − SUM(DEBIT)` sobre todo o ledger. É independente do saldo armazenado; usar o último `balance_after` não detectaria um lançamento perdido.
- **Verificação de cadeia** (recomendada): cada `balance_before` igual ao `balance_after` anterior, versões consecutivas, primeira versão 1 (`balance_before = 0`) ou 2 (wallet nascida zerada), última versão = `wallets.version`. Pega erros que a soma não pega (lançamentos que se anulam em valor mas estão fora de ordem).
- **Divergência:** log de erro, `reconciliation_divergences_total`++, `consistent: false`. Nunca corrige (corrigir apagaria a evidência).
- `assertLedgerInvariant` dos testes **é a mesma função** (reaproveitamento e prova de que a reconciliação funciona).
- Resposta sempre 200 (P-9). Obedece à ordem de locks (nenhum lock).

## Consequências
- (+) Sem falso positivo; sem impacto na wallet quente. (−) Custo O(n) no ledger (documentado; índice por wallet).
