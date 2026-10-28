# W0 — Fundação

**Slot:** terça à noite · **Branch:** `main` (commit direto) · **Depende de:** nada · **Libera:** W1 e W2 (em paralelo) · **Tamanho:** P

## Prompt (cole na sessão)

```text
Você é a sessão executora da Onda W0 — Fundação do desafio Distributed Wagering Processor.
Trabalhe dentro do WSL, na pasta do repositório (~/projetos/backend-challenge), branch main.
Leia nesta ordem: CLAUDE.md, specs/README.md, specs/waves/_common.md e specs/waves/W0-fundacao.md. Depois leia somente a seção "Leitura" deste arquivo.
Execute APENAS o Passo A (commit de preparação) e a tarefa T-001, seguindo o protocolo de _common.md (testes primeiro, commit, gate, prova de dentes, relatório).
Não altere specs nem ADRs. Em dúvida de decisão, pare e pergunte no formato Problema/Opções/Recomendação/Explicação.
Ao final: rode o gate, escreva specs/waves/reports/W0-report.md e informe o veredito com a evidência.
```

## Pré-requisito do autor (antes de colar o prompt)

- Bun 1.x instalado **no WSL** (`curl -fsSL https://bun.sh/install | bash`; `bun --version` precisa funcionar num shell novo). Hoje o Bun **não** está instalado.
- Docker e Compose já funcionam no WSL (verificado: Docker 29, Compose 5; 7,9 GB de RAM, 8 cores).
- `git config user.name` e `user.email` definidos no WSL.

Se `bun --version` falhar, a sessão **para** e avisa; não instala nada por conta própria.

## Leitura

[01-requirements.md](../01-requirements.md) (RNF-01 e RNF-05) · [ADR-0003](../adr/0003-arquitetura-hexagonal-e-topologia.md) · [ADR-0020](../adr/0020-ferramentas-e-validacao.md) · [02-design.md](../02-design.md) §1 (estrutura de pastas) · [06-tasks.md](../06-tasks.md) (T-001).

## Passo A — commit de preparação (não é uma tarefa T-xxx)

Hoje `CLAUDE.md` e `specs/` estão **sem commit** (untracked) e já contêm as edições aprovadas pelo autor em 2026-10-27 (idioma, splits de tarefas, T-026, plano de ondas). Commite-os **exatamente como estão**, sem editar o conteúdo:

```
docs(specs): adiciona specs, ADRs, plano de ondas e CLAUDE.md
```

Antes: `git status` mostra só `CLAUDE.md` e `specs/` como novos. Se houver mais alguma coisa, pare e pergunte.

## Tarefa

| Tarefa | O que entregar | Requisitos |
|---|---|---|
| **T-001** | Scaffold Bun + TypeScript estrito + estrutura de pastas + scripts + ferramentas base | RNF-01, ADR-0020 |

### T-001 em detalhe

- `package.json` (`"private": true`, `"type": "module"`), versões **fixas** das dependências de desenvolvimento: `typescript`, `@types/bun`, `@biomejs/biome`.
- `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `experimentalDecorators` e `emitDecoratorMetadata` (o Nest vai precisar; ADR-0020), alvo moderno, `moduleResolution: bundler`, `types: ["bun"]`, sem path aliases (imports relativos).
- Estrutura do [02-design §1](../02-design.md) e do mapa do `CLAUDE.md`: `src/shared`, `src/modules/{wallet,wagering,messaging,platform}/{domain,application,infrastructure}` (conforme cada módulo; `platform` não tem `domain`), `test/{unit,integration,concurrency,support}`. Pastas vazias recebem `.gitkeep`.
- Scripts que **precisam funcionar já**: `typecheck` (`tsc --noEmit`), `lint` (`biome check .`), `format`, `test:unit` (`bun test test/unit`). Defina também `test:integration`, `test:concurrency` e `test` como contrato, mas só `test:unit` entra no gate (as outras suítes ainda não têm testes).
- **Biome baseline** com as regras recomendadas e formatação consistente. A afinação (`noFloatingPromises`, `useImportType` desligado por causa de DI) é da T-004: aqui só precisa **lintar o domínio puro** da trilha paralela (fronteira N7 em [07-waves.md](../07-waves.md)).
- `.gitignore` (ao menos `node_modules`, `.env`, `coverage`, `dist`), `.editorconfig`, `.env.example` mínimo (pode estar quase vazio).
- **Teste de fumaça** `test/unit/scaffold.test.ts` com título `RNF-01 scaffold …`: lê `tsconfig.json` e afirma `strict` e `noUncheckedIndexedAccess`; afirma que as pastas esperadas existem. É a evidência de RNF-01.
- Marque `T-001` em `06-tasks.md` no mesmo commit. Commit sugerido: `build: cria scaffold Bun com TypeScript estrito (T-001)`.

## Gate

| # | Comando / verificação | Esperado |
|---|---|---|
| 1 | `bun --version` | 1.x |
| 2 | `bun install --frozen-lockfile` | ok |
| 3 | `bun run typecheck` | 0 erros |
| 4 | `bun run lint` | 0 erros |
| 5 | `bun run test:unit` (3×) | verde, 0 skip |
| 6 | Checagem de skips e de IDs (`_common.md` §9) | limpa; `RNF-01` presente |
| 7 | `git log --oneline` | exatamente 2 commits novos (Passo A e T-001) + o commit do relatório |

**Prova de dentes:**
- Remova `noUncheckedIndexedAccess` do `tsconfig.json` → o teste de fumaça fica vermelho. Restaure.
- Crie um arquivo temporário com `const a: number[] = []; const x: number = a[0];` → `typecheck` precisa falhar (prova que a flag está ativa). Apague o arquivo.

## Pare e pergunte se

- `bun` não existir; o `git status` tiver sujeira além de `CLAUDE.md` e `specs/`; alguma versão fixada não resolver; o Biome recomendado quebrar o `tsconfig`.

## Fora do escopo

Nest, MikroORM, AWS SDK, prom-client, commitlint, Compose, `main.ts` (W1, W3, W4). Não crie `src/main.ts`.

## Entregáveis

2 commits + commit do relatório · `specs/waves/reports/W0-report.md` · **CP0:** `main` com specs, scaffold e `typecheck/lint/test:unit` verdes.
