# ADR-0005 — `Money` com Decimal (big.js), escala fixa de 2

- **Status:** Aceita · **Data:** 2026-10-27 · **Relacionados:** RF-MNY-*

## Contexto
Restrição inviolável: nada de `number`/`float`/`double` para dinheiro. O esqueleto do enunciado usa `Decimal`. Entradas com mais de 2 casas são rejeitadas.

## Opções consideradas
| Opção | Prós | Contras |
|---|---|---|
| `bigint` em centavos | Exato, sem dependência | Diverge do esqueleto; precisa de justificativa extra |
| **`big.js` (Decimal)** | Alinhado ao esqueleto; API pronta | Uma dependência; exige disciplina para nunca virar `number` |
| `decimal.js` | Madura | Maior que o necessário |

## Decisão
`big.js` no domínio, escala fixa de 2, parse estrito `^\d+\.\d{2}$` (máximo de 17 dígitos inteiros, para caber em `NUMERIC(19,2)`; excesso → 400, não 500). Cuidados:
1. `Money` só é construído a partir de **string validada**, nunca de `number`.
2. Serialização sempre `toFixed(2)` (o `toString()` do big.js pode usar notação exponencial).
3. Dinheiro em eventos e contratos é `MoneyProps` (string).
4. Banco: `NUMERIC(19,2)`; o driver devolve `numeric` como string, então o valor nunca passa por `number`.
5. Teste de serialização falha se algo converter para `number`.

Como as entradas nunca têm mais de 2 casas, **não existe arredondamento**; a exatidão vem da escala fixa e da rejeição.

## Consequências
- (+) Segue o texto do enunciado; sem discussão de aderência.
- (−) Dependência extra pequena; documentada no `ARCHITECTURE.md`.
