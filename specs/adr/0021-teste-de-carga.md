# ADR-0021 — Teste de carga e comparação das estratégias A × C em microbenchmark isolado

- **Status:** Aceita · **Data:** 2026-10-29 · **Complementa:** [ADR-0006](0006-concorrencia-lock-pessimista.md) · **Relacionados:** [ADR-0014](0014-outbox-e-eventos.md), stretch S-01

## Contexto
O ADR-0006 prevê que o `test:load` compare a estratégia A (`SELECT … FOR UPDATE`) com a C (`UPDATE` condicionado). O enunciado (§14) pede ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos de concorrência e outbox lag, sem meta de RPS. A estratégia padrão não está em jogo e `src/` não pode mudar.

## Decisão
1. **Ferramenta:** script Bun próprio (`fetch` + pool de promessas) em `test/load/`; sem k6 e sem dependência nova.
2. **Ambiente:** 3 instâncias via `Bun.spawn` sobre a infra de teste (Postgres 5433, SQS 4567), com banco e filas novos por execução e portas HTTP livres. Não usa o Compose de dev.
3. **Cenários:** N1 (200 wallets distintas), N2 (wallet quente, 50 concorrentes), N3 (mix 70 % `BET`, 15 % `WIN`, 5 % duplicata, 5 % `REFUND`, 5 % `LOSS`) via HTTP, e N4 via SQS (tempo até o consumo).
4. **Duração:** por tempo, 10 s de aquecimento descartado + 30 s medidos por cenário; `--profile smoke` (~5 s) para o teste automatizado; duração e concorrência por flag.
5. **Erro de carga:** `5xx`, timeout e falha de conexão. Rejeições de negócio esperadas (por exemplo `422 INSUFFICIENT_FUNDS`) não contam.
6. **Invariante:** após cada execução, `assertLedgerInvariant` em todas as wallets tocadas, sem saldo negativo, sem débito duplicado e outbox esvaziando; violação sai com código ≠ 0.
7. **A × C:** microbenchmark em SQL isolado (`test/load/`), 50 conexões `pg` na mesma wallet real, ledger gravado igual nas duas variantes. **Sem flag nem caminho alternativo em `src/`.** É SQL contra SQL: sem HTTP, outbox, inbox, referências ou estados; o relatório não extrapola e A segue como estratégia do projeto.
8. **Saída:** tabela impressa e JSON em `test/load/results/` (ignorado pelo git). O relatório humano é `LOAD-REPORT.md` na raiz (PT-BR), escrito de execuções reais (3× por cenário, com dispersão).
9. **Suíte:** a carga completa não entra em `bun run test`; só o perfil smoke (TST-I-22) e o microbenchmark curto (TST-I-23).

## Consequências
- (+) Experimento reprodutível, isolado, sem tocar a produção. (−) Gerador e servidor dividem a máquina (WSL) e o SQS é emulado: os números são comparativos, não absolutos; o relatório registra isso.
