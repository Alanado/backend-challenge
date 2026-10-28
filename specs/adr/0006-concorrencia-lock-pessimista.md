# ADR-0006 — Concorrência: lock pessimista por wallet (+ isolamento)

- **Status:** Aceita · **Data:** 2026-10-27 · **Relacionados:** RF-CON-*, RF-WAL-03

## Contexto
A unidade de concorrência é a `walletId`. Em wallet quente, muitas apostas disputam o mesmo saldo e todas precisam ver o valor correto. Restrições: sem lock global, sem `read → calculate → update` sem controle, correto com N instâncias.

## Opções consideradas
| Opção | Prós | Contras |
|---|---|---|
| **A. `SELECT … FOR UPDATE` na wallet** | Determinística, sem retry, mantém `Wallet.debit()` rico | Transações da mesma wallet se serializam; seguram conexões do pool |
| B. Otimista com `version` e retry | Sem espera | Em hot row vira tempestade de retries, trabalho refeito |
| C. `UPDATE` atômico condicionado (`balance >= x`) | Mais rápida | A regra de saldo vai para o SQL; `debit()` vira decorativo; o lock da linha ainda dura até o commit |
| E. Fila single-writer por wallet | Libera o pool | Fora de escopo; evolução natural |

## Decisão
**A**, com defesas em profundidade:
1. `UPDATE wallets … WHERE id = $1 AND version = $esperada` — assert que nunca deve falhar; se falhar é bug e **a correção não é adicionar retry**.
2. `CHECK (balance >= 0)`.
3. `UNIQUE (wallet_id, wallet_version)` no ledger.
4. `UNIQUE (provider_id, idempotency_key)` em `wager_transactions`.
5. `lock_timeout` (5 s) e `statement_timeout` (15 s).

**Isolamento:** `READ COMMITTED`. Cada garantia tem mecanismo nomeado (lock, UNIQUE, CHECK), mais auditável que um isolamento implícito; `SERIALIZABLE` exigiria retry em toda a aplicação. Regra: **toda decisão que depende do saldo lê a wallet com `FOR UPDATE`** (exceções: `GET` e reconciliação, que são relatórios).

Cada operação toca **uma só wallet** (a referência precisa ser da mesma wallet), então "ordem de locks entre wallets" **não se aplica**.

## Consequências
- (+) Correção fácil de provar e de testar; sem retries.
- (−) Wallet quente tem vazão limitada pela duração da transação; por isso a transação é curta e sem I/O externo dentro dela.
- `lock_timeout` e deadlock são falhas **transitórias** (503 / retry).
- Alternativas C e E documentadas; `test:load` (stretch) compara A e C.
