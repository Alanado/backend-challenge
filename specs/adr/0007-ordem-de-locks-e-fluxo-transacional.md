# ADR-0007 — Ordem canônica de locks e fluxo transacional

- **Status:** Aceita · **Data:** 2026-10-27 · **Relacionados:** RF-CON-05, RF-IDP-06 · **Não alterar sem consultar o autor**

## Contexto
Um `INSERT` em `wager_transactions` toma `FOR KEY SHARE` na linha da wallet (checagem da FK). Esse lock **conflita com `FOR UPDATE`**.

## O problema (descartado)
Ordem "inserir transação → travar wallet": A insere (KEY SHARE em W), C insere (KEY SHARE em W); A pede `FOR UPDATE` e espera C; C pede `FOR UPDATE` e espera A → **deadlock**. Ordem "travar wallet → inserir" com a chave de idempotência inserida depois é a correta. (Primeira proposta, com *insert-first*, foi corrigida na Rodada 3.)

## Decisão
**Ordem canônica de aquisição: (1) inbox → (2) lock da wallet (`FOR UPDATE`) → (3) linhas e índices de `wager_transactions`.** Nenhuma transação adquire um recurso de nível menor depois de um de nível maior. Por haver ordem total, não há ciclo. Vale para HTTP, consumidor, worker de referências e reconciliação.

Fluxo (02-design §5): fast path sem lock por chave (HTTP) → inbox (SQS) → `FOR UPDATE` da wallet → `INSERT … ON CONFLICT DO NOTHING` **sem alvo de conflito** (cobre chave e id externo) → resolver referência → aplicar → commit.

Pontos de atenção:
- A resolução da referência acontece **depois** do lock da wallet: reversões da mesma wallet estão serializadas, então "já foi revertida?" não fica desatualizada; o índice parcial é a rede de segurança.
- Conflito de (`provider_id`, `external_transaction_id`) entre wallets diferentes: o `INSERT` espera a transação com a linha não confirmada. **Sem ciclo**, pois nenhuma das duas precisa da outra wallet. Coberto por teste de concorrência (TST-C-09).
- Deadlock detectado (`40P01`) é **transitório**: 503 no HTTP, retry no SQS, conta em `lock_conflicts_total`.
- O inbox não tem FK para a wallet (sem `KEY SHARE`): uma duplicata do mesmo `messageId` espera a primeira sem segurar locks.
- O `UPDATE` que acorda dependentes se restringe à `wallet_id` travada.

## Consequências
- (+) Sem deadlock por construção; coberto por TST-C-10.
- (−) Duplicatas na mesma wallet esperam na fila da wallet (a leitura inicial sem lock alivia replays tardios).
