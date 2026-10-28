# ADR-0004 — Domínio separado da persistência (EntitySchema + mappers)

- **Status:** Aceita · **Data:** 2026-10-27 · **Relacionados:** RF-MNY-05

## Contexto
O enunciado exige construtores `private` com fábricas (`create`, `from`, `rehydrate`), proíbe o domínio de depender do ORM e dos decorators do NestJS, e define que `rehydrate` não revalida transições.

## Opções consideradas
| Opção | Como funciona | Trade-off |
|---|---|---|
| **A. Modelos de persistência separados + mappers (escolhida)** | O ORM usa `EntitySchema` de dados; um mapper converte para o domínio via `rehydrate` | Mais código de mapeamento; domínio 100% testável sem banco; coerente com o enunciado |
| B. Mapear as classes de domínio direto no ORM | Menos código | A hidratação do ORM contorna construtores privados e `rehydrate`; rastreamento do Unit of Work sobre campos privados é frágil |

## Decisão
Opção A. O caminho crítico de concorrência (lock da wallet, inserts condicionados) usa o `EntityManager` e, quando necessário, SQL explícito.

## Consequências
- (+) Domínio sem dependências; testes unitários rápidos; fácil de defender.
- (−) Mapeamento a manter; teste de round-trip (domínio → banco → domínio) nas migrations.
- Verificado por teste de arquitetura (TST-U-13).
