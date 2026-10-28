# ADR-0009 — Ledger imutável, ordenação e imutabilidade de transações terminais

- **Status:** Aceita · **Data:** 2026-10-27 · **Relacionados:** RF-LED-*, I-4, I-8

## Contexto
Restrição 5: não sobrescrever nem excluir lançamentos. Restrição 9: imutabilidade garantida no schema. O cursor de paginação precisa ser estável.

## Opções consideradas (imutabilidade)
| Opção | Trade-off |
|---|---|
| **A. Triggers `BEFORE UPDATE OR DELETE` e `BEFORE TRUNCATE` que lançam exceção** | Vale até para o dono da tabela; testável |
| B. `REVOKE UPDATE, DELETE` do papel da aplicação | Simples, mas não protege contra o dono/superusuário |
| C. Ambos | Mais robusto; mais configuração (evolução) |

## Decisão
- **A** para o ledger. O mesmo padrão protege `wager_transactions` terminais (`PROCESSED`/`REJECTED`/`FAILED` não mudam; `DELETE` proibido; colunas de identidade imutáveis).
- `UNIQUE (wallet_id, wallet_version)`, onde `wallet_version` é a versão da wallet logo após o lançamento (a abertura com saldo inicial usa `1`; wallet nascida zerada tem a primeira entrada na versão `2`). Como a wallet é serializada pelo lock, a ordem é total; o cursor opaco é a versão em base64url.
- `UNIQUE (wallet_id, transaction_id)` (no máximo um lançamento por wallet e transação) e `CHECK` de aritmética (`balance_after = balance_before ± amount`).
- `balance_before`/`balance_after` ≥ 0.
- **Constraint trigger `DEFERRABLE INITIALLY DEFERRED`** que verifique "saldo da wallet = último `balance_after`" no commit: **stretch (S-02)**; hoje a reconciliação e os testes cobrem o risco.

## Consequências
- `DROP TABLE` não dispara os triggers de linha; um `down` que **apague linhas** precisa desabilitar o trigger antes. `TRUNCATE` é bloqueado, por isso os testes usam banco novo por suíte (ADR-0019).
- (+) A imutabilidade não depende do código da aplicação.
