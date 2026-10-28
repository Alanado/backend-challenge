# W11 — Documentação e hardening

**Slot:** sexta à tarde · **Branch:** `wave/w11` (a partir da `main` com W10) · **Depende de:** W10 · **Libera:** entrega (e o stretch) · **Tamanho:** M

## Prompt (cole na sessão)

```text
Você é a sessão executora da Onda W11 — Documentação e hardening do desafio Distributed Wagering Processor.
Trabalhe dentro do WSL, na pasta do repositório, branch wave/w11, criada a partir da main que contém a W10 (código congelado).
Leia nesta ordem: CLAUDE.md, specs/README.md, specs/waves/_common.md e specs/waves/W11-docs-e-hardening.md. Esta onda PODE ler a spec inteira e os relatórios em specs/waves/reports/.
Execute APENAS T-060, T-061, T-062 e T-063, nesta ordem, um commit por tarefa, protocolo de _common.md. Documentação em PT-BR. A documentação descreve o que o código FAZ (confirme no código e nos testes), não o que a spec dizia.
Não altere código de produção, specs nem ADRs nesta onda; qualquer divergência entre spec e implementação vai para o relatório e para uma pergunta ao autor. Ao final: rode o gate, escreva specs/waves/reports/W11-report.md e informe o veredito com a evidência.
```

## Leitura

Tudo: [README do desafio](../../README.md) (inclusive §14, falhas eliminatórias) · [specs/README.md](../README.md) · todas as specs `00`–`07` · todos os [ADRs](../adr/) · [study-guide.md](../study-guide.md) · `specs/waves/reports/W*-report.md` (desvios e decisões registradas pelas ondas) · `adr/0002-spike.md` · `package.json`, `docker-compose*.yml`, `Dockerfile`.

## Pré-condições

`main` com W10 verde e relatórios de W0–W10 presentes. `bun run test` verde 3× (relatório da W10). Docker pronto.

## Tarefas

| Tarefa | Entrega | Verificação que a fecha |
|---|---|---|
| **T-060** | `README.md` (raiz): setup, comandos, 3 instâncias, testes, uso de IA/SDD | script de conferência dos comandos + execução literal |
| **T-061** | `ARCHITECTURE.md` (raiz) | conferência de seções obrigatórias + links |
| **T-062** | Revisão de rastreabilidade + `study-guide.md` atualizado | script de rastreabilidade |
| **T-063** | Passada final | suíte 3×, cobertura, Compose do zero, clone limpo |

### T-060 — README.md

O `README.md` da raiz hoje **é o enunciado do desafio**. **Não o apague nem o reescreva**: preserve o enunciado e acrescente, no topo (antes do enunciado) ou em arquivo referenciado por ele, a seção do candidato. Decida a forma menos invasiva e **reporte**; se houver dúvida, pare e pergunte. Conteúdo (avaliação: "README com setup e comandos"): pré-requisitos (Bun, Docker), `bun install`, subir a infra de teste, rodar migrations, rodar a aplicação local, **rodar 3 instâncias** (`docker compose up --build`), todos os comandos de teste (`test:unit`, `test:integration`, `test:concurrency`, `test`, e `test:load` só se existir), health e `/metrics`, exemplos de `curl` (criar wallet, `BET`, replay, reversão, ledger, reconciliação), variáveis de ambiente (tabela), estrutura do repositório, **declaração de uso de IA e SDD** (ADR-0001: o que a IA fez, o que foi decisão do autor, como foi validado — specs, testes, revisão por onda, matriz de rastreabilidade), links para `ARCHITECTURE.md` e `specs/`.
- **Verificação:** script `scripts/check-readme-commands.ts` que extrai os comandos `bun run <script>` do README e confirma que cada script existe no `package.json`; **execute literalmente** os passos de setup num clone limpo (ver T-063) e registre.

### T-061 — ARCHITECTURE.md

Curado a partir dos ADRs e **conferido contra o código e os relatórios das ondas**. Seções obrigatórias:
1. Visão geral e diagrama dos módulos/portas (hexagonal enxuta).
2. **ORM:** por que MikroORM, como `Money` é mapeado (`NUMERIC(19,2)` ↔ string ↔ `Money`), estratégia transacional (`READ COMMITTED` + locks) — o enunciado §4 exige esta justificativa aqui.
3. **Concorrência:** lock pessimista por wallet, alternativas descartadas (otimista, `UPDATE` condicionado, fila single-writer), defesas em profundidade.
4. **Ordem canônica de locks** e o deadlock de `KEY SHARE` evitado (diagrama).
5. **Idempotência:** colunas na `wager_transactions`, `payloadHash` (algoritmo documentado), duas camadas (inbox × chave), replay com saldo observado.
6. **Ledger imutável** (triggers) e **reconciliação** (snapshot, cadeia, nunca corrige).
7. **Outbox/Inbox/consumidor/DLQ/breaker/shutdown** com os cenários de falha.
8. **Referências fora de ordem** (backoff, limites e justificativa).
9. **Taxonomia de `failureCode`/`errorCode`** e **mapeamento de status HTTP** (com a regra "não reenviar 422 com a mesma chave").
10. **Interpretações do enunciado** (as 9 de [01-requirements §12](../01-requirements.md)), em especial a **regra 4 × reversão única** ([ADR-0010](../adr/0010-reversao-unica-por-referencia.md)), citando a regra, o cenário e a decisão.
11. **Autenticação:** não implementada; desenho (OIDC, client credentials, `azp` → `providerId`, JWKS) e o ponto de extensão no código ([ADR-0017](../adr/0017-autenticacao.md)).
12. **Observabilidade:** logs (campos e proibidos), métricas (lista), health.
13. **Testes:** estratégia, infra (banco por suíte, filas por suíte, `Bun.spawn`, `TEST_FAULT` e sua recusa em produção), como provar as garantias.
14. **Limitações assumidas** (lista honesta do [study-guide §5](../study-guide.md) **mais** o que as ondas registraram: o que foi cortado, se algo foi).
15. **Trade-offs e evolução** (fila single-writer, SNS, retenção de inbox/outbox, reprocesso de DLQ).
- **Verificação:** `scripts/check-architecture.ts` (seções obrigatórias presentes; todo link relativo resolve; todo ADR citado existe).

### T-062 — rastreabilidade

- `scripts/check-traceability.ts`: lê `01-requirements.md` e extrai todos os `RF-*`/`RNF-*` com os `TST-*` citados; varre `test/` por títulos com ID; falha se um requisito com teste não tiver **nenhum** teste correspondente no código, se um `TST-*` do [05-test-plan](../05-test-plan.md) não existir nos testes, ou se houver tarefa em `[ ]`. Gere a **matriz final** (requisito → tarefa → arquivo de teste) em `specs/traceability.md` (arquivo gerado, regenerável).
- Atualize o `study-guide.md` com **o que mudou na implementação** em relação ao desenho (fonte: seções "Desvios" dos relatórios). **Não edite ADRs nem specs numeradas:** se um desvio exigir isso, registre e pergunte ao autor.
- Se a linha de corte foi usada (ex.: T-044), os requisitos afetados aparecem como "não implementado, documentado" e não como buraco silencioso.

### T-063 — passada final

1. **Clone limpo** em diretório temporário (`git clone` do repo local), seguir o README **literalmente**: `bun install --frozen-lockfile`, infra, migrations, suíte.
2. `bun run test` **3× seguidas** (flakiness), `bun test --coverage` anexado (sem limite numérico; liste os caminhos críticos com baixa cobertura).
3. `docker compose down -v && docker compose up --build` do zero; `compose:smoke`.
4. **Checklist das falhas eliminatórias do README §14**, uma linha cada, com a evidência (teste/arquivo/comando): `number` para dinheiro (varredura estática + U-02); saldo negativo por race (C-02, C-12, `CHECK`); débito/crédito duplicado (C-01, C-11, C-05); idempotência só em memória (C-08, `UNIQUE`); correto só com uma instância (C-04); publicação antes do commit (I-13, C-06); ausência de ledger auditável (I-03, I-14); mocks substituindo PG e SQS (varredura: nenhum mock de `pg`/SDK nos testes de integração/concorrência).
5. Varreduras: `grep` de segredos, de `skip/todo/only`, de `console.log` em `src/`, de `TEST_FAULT` aceita em produção.
6. Revisão da lista de arquivos versionados (`.gitignore`, sem `node_modules`, sem `.env`).

## Gate

| # | Verificação | Esperado |
|---|---|---|
| 1 | `bun run typecheck` · `lint` | limpos |
| 2 | `bun run test` 3× seguidas | verdes, 0 skip |
| 3 | `scripts/check-readme-commands.ts` · `check-architecture.ts` · `check-traceability.ts` | exit 0 |
| 4 | Clone limpo + README literal | funciona; passos executados listados |
| 5 | `docker compose up --build` do zero + `compose:smoke` | exit 0 |
| 6 | Checklist de eliminatórias | 8 linhas, todas com evidência |
| 7 | `git diff main -- src` desta branch | **vazio** (nenhum código de produção alterado) |

**Provas de dentes:** apague um teste de um `TST-*` → o script de rastreabilidade falha; quebre um link em `ARCHITECTURE.md` → o script acusa; renomeie um script no `package.json` → o conferidor do README acusa. Restaure.

## Pare e pergunte se

A documentação revelar divergência entre código e ADR/spec; faltar evidência para uma falha eliminatória; o formato do README exigir decisão (preservar o enunciado); qualquer tarefa pedir mais de um commit.

## Fora do escopo

Código de produção; ADRs; stretch.

## Entregáveis

4 commits + relatório · `README.md`, `ARCHITECTURE.md`, `specs/traceability.md`, scripts de conferência · **projeto pronto para entrega**.
