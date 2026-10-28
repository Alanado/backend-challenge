# ADR-0019 — Estratégia de testes

- **Status:** Aceita · **Data:** 2026-10-27 · **Relacionados:** 05-test-plan

## Contexto
Testes que substituem completamente PostgreSQL e SQS por mocks são falha eliminatória. Os triggers do ledger bloqueiam `TRUNCATE`, inviabilizando limpeza entre testes. O ambiente tem 8 GB de RAM.

## Opções (infraestrutura)
| Opção | Trade-off |
|---|---|
| A. Testcontainers por suíte | Isolamento total; pesado em 8 GB; compatibilidade com Bun não validada |
| **B. Um Postgres e um emulador SQS de teste via Compose; banco novo por suíte (template) e filas com sufixo aleatório** | Leve; resolve o `TRUNCATE` bloqueado |

## Decisão
**B**, mais:
- **Banco template** migrado uma vez; `CREATE DATABASE … TEMPLATE …` por suíte (o helper garante que nenhuma conexão esteja aberta no template). Dentro da suíte, ids únicos em vez de limpeza.
- **Concorrência real:** `Bun.spawn` com ≥ 3 processos da aplicação.
- **Seam de injeção de falha** (`TEST_FAULT`) para morte determinística entre commit e ack e para falha no meio da transação; **a aplicação recusa a variável em produção** (`NODE_ENV=production`), para não virar vetor de derrubada.
- **Determinismo:** `eventually(...)`, `Clock` injetável, sem `sleep` fixo.
- **`assertLedgerInvariant`** = mesma função da reconciliação; roda ao fim de todo teste de integração e concorrência.
- Estrutura `test/{unit,integration,concurrency,support}`; scripts `test`, `test:unit`, `test:integration`, `test:concurrency`, `test:load`. Cobertura reportada, sem limite numérico.

## Consequências
- (+) Provas com banco e fila reais; reproduzível. (−) Infra de teste própria a manter; seam de falha presente no código de produção (guardado).
