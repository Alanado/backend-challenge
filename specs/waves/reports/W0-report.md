# Relatório W0 — Fundação
- Data: 2026-10-27 · branch: main · HEAD: d4787e7 (antes do commit do relatório)
- Veredito: VERDE (com desvio no Passo A, abaixo)

## Tarefas
| Tarefa | Commit | Testes que a fecham (ID → arquivo) | Vermelho → verde |
|---|---|---|---|
| T-001 | d4787e7 | RNF-01 → test/unit/scaffold.test.ts | 2 fail (tsconfig.json ausente; pastas ausentes) → 2 pass |

## Gate (saída real)
| Comando | Exit | Resumo |
|---|---|---|
| bun --version | 0 | 1.4.4 (no PATH só via ~/.bun/bin; sessão exportou o PATH) |
| bun install --frozen-lockfile | 0 | sem mudanças |
| bun run typecheck | 0 | 0 erros |
| bun run lint | 0 | 4 arquivos, 0 erros |
| bun run test:unit (3×) | 0 | 2 pass / 0 fail / 0 skip em cada execução |
| grep de skips | sem match | limpo |

## IDs de teste exigidos × encontrados
RNF-01 presente (test/unit/scaffold.test.ts). Sem IDs TST-* exigidos na W0.

## Provas de dentes
| Mutação aplicada | Teste que falhou | Restaurado |
|---|---|---|
| remover noUncheckedIndexedAccess do tsconfig.json | RNF-01 scaffold enables strict TypeScript flags | sim (git checkout) |
| src/tmp.ts com `const x: number = a[0]` | typecheck falhou com TS2322 (number \| undefined) | sim (arquivo apagado) |

## Desvios, decisões, dependências adicionadas
- **Passo A não executado:** CLAUDE.md e specs/ já estavam commitados pelo autor (77cc089, c31b7af); working tree limpo. Autor confirmou. Por isso há 1 commit de tarefa, não 2.
- Dependências (versões fixas): typescript 7.0.2, @types/bun 1.4.4, @biomejs/biome 2.6.3 (ferramentas base exigidas pela T-001).
- biome.json ignora specs/, README.md, CLAUDE.md e bun.lock: o primeiro `bun run format` reformatou specs/ e README; foi revertido com git checkout antes do commit e o escopo do Biome restrito ao código.
- Biome com preset recommended; afinação fica para a T-004.

## Perguntas em aberto / bloqueios
Nenhum.

## Pré-condições da próxima onda verificadas
Não verificadas (fora do escopo da W0).
