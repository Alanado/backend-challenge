# Relatório W1 — Spikes e infra base
- Data/hora: 2026-10-27 22:32 (America local) · branch: `wave/w1` (worktree `../backend-challenge-w1`, criado nesta sessão a partir da `main` em 0cff7aa, pois não existia) · HEAD: 98636ef (antes do commit do relatório)
- Veredito: **VERDE**. R-01, R-02 e R-03 passaram sem precisar de plano B; nenhum gatilho de parada foi acionado.

## Tarefas
| Tarefa | Commit | Testes / scripts que a fecham | Vermelho → verde |
|---|---|---|---|
| T-002 | 7c0c5fa | `bun run spike:nest-mikro` (14 itens) | 1ª execução: 12/14, falharam 7b e 7c (`orm.getMigrator is not a function`; na v7 é `orm.migrator`) → 14/14 |
| T-003 | 5f0437c | `bun run spike:sqs` (11 itens), rodado em LocalStack 4.14.0 e MiniStack 1.5.33 | MiniStack 10/11 (item 7 falha: aceita `MessageGroupId` de 129 caracteres) → escolhido LocalStack 4.14.0, 11/11 |
| T-004 | 01ffc18 | `bun run spike:tooling` (4 itens) · `test/unit/tooling/lint-rules.test.ts` (4) · `test/unit/tooling/commit-msg-hook.test.ts` (7) | lint-rules: 2 fail (regra desligada; `useImportType` ainda ativa); hook: 5 fail (hook inexistente) → 11 pass |
| T-005a | f2976ee | `test/integration/infra.smoke.test.ts` (INFRA-01..05, 5 testes) | `ECONNREFUSED 127.0.0.1:5433` (sem infra) → 5 pass |
| T-006 | 98636ef | evidência do hook em commit real (abaixo); `bun run test` verde | antes: `bun run test:concurrency` saía com 1 (sem arquivos de teste) → `--pass-with-no-tests` |

## Gate (saída real)
| # | Comando | Exit | Resumo |
|---|---|---|---|
| 1 | `git status` | 0 | limpo |
| 1 | `bun install --frozen-lockfile` | 0 | `Checked 236 installs across 264 packages (no changes)` |
| 2 | `bun run test:infra:down` + `test:infra:up` ×2 | 0 / 0 | 1ª: `created` ×3; 2ª: `unchanged` ×3 (idempotente) |
| 1 | `bun run typecheck` | 0 | sem erros |
| 1 | `bun run lint` | 0 | `Checked 19 files`, 0 erros, 0 warnings |
| 3 | `bun run spike:nest-mikro` | 0 | 14/14 |
| 3 | `bun run spike:sqs` | 0 | 11/11 |
| 3 | `bun run spike:tooling` | 0 | 4/4 |
| 4 | `bun run test:unit` | 0 | 13 pass / 0 fail / 0 skip |
| 4 | `bun test test/integration/infra.smoke.test.ts` ×3 | 0 | 5 pass / 0 fail em cada uma das 3 |
| 4 | `bun run test` (unit + integration + concurrency) | 0 | 13 + 5 pass, 0 fail |
| 8 | `bun run test:infra:down` | 0 | contêineres e rede removidos |

**Item 5 do gate — hook de commit (commits reais, nada ficou no histórico; `HEAD` inalterado depois de cada tentativa):**
```
$ git commit -m "adicionei uns comandos"
✖   subject may not be empty [subject-empty]
✖   type may not be empty [type-empty]
✖   found 2 problems, 0 warnings          (exit 1)
$ git commit -m "Feat: Comandos."
✖   type must be lower-case [type-case]
✖   type must be one of [build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test] [type-enum]
✖   found 4 problems, 0 warnings
$ git commit -m "docs(claude): atualiza comandos reais e ferramentas ativas (T-006)"   -> aceito (98636ef)
```
Os 5 commits da onda foram todos aceitos pelo hook (descrições em português com acentos).

**Item 6 do gate — fixture de promise solta** (`test/support/fixtures/lint/floating-promise.ts.txt`, Biome com a configuração real do repositório):
```
fixture.ts:6:2 lint/nursery/noFloatingPromises
  × A "floating" Promise was found, meaning it is not properly handled and could lead to ignored errors ...
  > 6 │ 	save();
Found 1 error.        (exit 1)
```

## IDs de teste exigidos × encontrados
A W1 não exige IDs `TST-*`. Existentes: `INFRA-01..05` (smoke) e `R-05` (tooling). `grep -rhoE "TST-[UIC]-[0-9]+" test` não retorna nada, como esperado. Skips: `grep -rnE "\.(skip|todo|only)\b|xit\(|xdescribe\(" test src` sem resultado.

## Provas de dentes
| Mutação aplicada | Teste que falhou | Restaurado |
|---|---|---|
| remover `RedrivePolicy` de `scripts/create-queues.ts`, `test:infra:down` + `up` | `INFRA-04 main queue redrives to the DLQ after 8 receives` (4 pass / 1 fail) | sim (`git checkout`; infra recriada; 5 pass) |
| `noFloatingPromises: "off"` em `biome.jsonc` | `R-05 a floating promise fails lint with noFloatingPromises` (3 pass / 1 fail) | sim (4 pass) |
| `.githooks/commit-msg` trocado por `exit 0` | 5 testes de rejeição (`type-empty`, `type-enum`, `subject-empty`, `subject-case/full-stop`, `no-co-authored-by`) (2 pass / 5 fail) | sim (7 pass) |

Obs.: a primeira tentativa da mutação do `RedrivePolicy` **não** foi aplicada (meu padrão de substituição não casou com o código já reformatado pelo Biome) e o smoke ficou verde; foi detectado por `git diff --stat` vazio e refeito com a mutação efetiva.

## Resultados dos spikes (resumo; detalhe em `specs/adr/0002-spike.md`)
- **R-02:** Nest 12.3.2 + MikroORM 7.2.5 + `@mikro-orm/nestjs` 7.1.0 no Bun 1.4.4 funcionam com **Express**; DI por tipo, `em.transactional`, `FOR UPDATE` / `SKIP LOCKED` / `NOWAIT` provados com duas conexões reais; SQLSTATE em `err.code` (`55P03`, `40P01`, `57014`); `numeric(19,2)` volta como string; `EntitySchema` e migrator up/down/create ok.
- **R-01/R-03:** `localstack/localstack:4.14.0` (última tag anterior a 2026.03, sem token) honra FIFO, grupos, bloqueio de cabeça de fila, dedup, DLQ FIFO com redrive, long polling, `ChangeMessageVisibility`, falha parcial do batch; erro de fila inexistente: `QueueDoesNotExist` / `AWS.SimpleQueueService.NonExistentQueue`, HTTP 400. Subida ≈3,4 s, ≈98 MiB ocioso.
- **R-04:** `prom-client` 15.1.3 serve counter/gauge/histogram em `/metrics`. Métricas padrão: só `process_*` e heap são reais; event loop lag fica 0, GC vazio.
- **R-05:** `noFloatingPromises` existe no grupo **nursery** do Biome 2.6.3 (ativada em `error`); `useImportType` desligada e documentada; commitlint sob Bun com hook em `.githooks/`, sem Husky.
- **R-06:** base (Postgres + LocalStack) ≈ 202 MiB.

## Desvios, decisões, dependências adicionadas
- **Worktree/branch criados nesta sessão:** `../backend-challenge-w1` e `wave/w1` não existiam; criados a partir da `main` (0cff7aa). `bun` só está em `~/.bun/bin` (igual à W0): o `PATH` foi exportado na sessão.
- **`biome.json` → `biome.jsonc`:** o arquivo `.json` não aceita comentários, e o enunciado pede documentar o motivo de `useImportType` no arquivo. As specs/ADRs ainda dizem `biome.json` (não alterados, conforme as regras).
- **Regra local de commitlint `no-co-authored-by`** (não pedida literalmente): impõe por máquina a regra do CLAUDE.md. Nenhuma regra de formato do `config-conventional` foi desligada.
- **`test:concurrency` com `--pass-with-no-tests`:** sem isso `bun run test` falhava por não haver arquivos em `test/concurrency` (chegam na W7). Sugestão: remover a flag quando os testes de concorrência existirem, para a ausência de arquivos voltar a falhar.
- **Spike `nest-mikro` cria o banco `spike`** se faltar; `spike:sqs` mede RAM do contêiner `wagering-test-sqs-1`. Ambos corrigidos em *fixup* nos commits do T-002/T-003 antes do gate (branch local, ainda não mergeada).
- **Compose:** o healthcheck do LocalStack aceita `available` **e** `running` (com só `available`, o contêiner ficaria `unhealthy` ~60 s depois do primeiro uso).
- **Portas:** infra de teste em 5433/4567; infra de dev em 5432/4566.
- **Dependências (versões fixas) e motivo:** `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express` 12.3.2; `@mikro-orm/core`, `@mikro-orm/postgresql`, `@mikro-orm/migrations` 7.2.5; `@mikro-orm/nestjs` 7.1.0; `pg` 8.23.1; `reflect-metadata` 0.2.2; `rxjs` 7.8.2 (stack do ADR-0002, spike T-002); `@aws-sdk/client-sqs` 3.1158.0 (T-003, script de filas e smoke); `prom-client` 15.1.3 (T-004); dev: `@commitlint/cli` e `@commitlint/config-conventional` 21.2.4 (T-004), `@types/pg` 8.23.1 e `@types/express` 5.0.6 (tipos dos spikes). As dependências de runtime ficaram em `dependencies`, mas só os spikes e scripts as usam por enquanto.
- **Nenhum spec/ADR alterado**, exceto o checkbox e o ponteiro "Resultados do spike" em `06-tasks.md` (pedidos pela T-006), `adr/0002-spike.md` (criado) e `CLAUDE.md`.
- Nenhum `any`, `@ts-ignore`, `@ts-expect-error` nem `biome-ignore` foi usado.

## Perguntas em aberto / bloqueios
Nenhum bloqueio. Para o autor decidir (nada foi alterado):
1. **Erro `QueueDoesNotExist`:** o item 8 do spike mostra `$fault = "client"`; a classificação do ADR-0015 deve tratá-lo como infraestrutura/transitório (não permanente → DLQ). Vale confirmar ao escrever o classificador (T-042a).
2. **Métricas padrão do `prom-client`:** recomendação do spike é ligar só como informação (`process_*`/heap) e não usar event loop lag/GC/handles como sinal.
3. **`noFloatingPromises` está no grupo `nursery`** (pode mudar em versão futura do Biome; a versão está fixada).

## Pré-condições da próxima onda verificadas
- W3 depende desta onda (e da W2): infra de teste sobe e é idempotente (`test:infra:up` ×2); `test:infra:down` ok.
- Pendente do autor: **mergear `wave/w1` na `main` antes da W3** (07-waves §5). Os hooks (`core.hooksPath`) são do `.git/config` compartilhado e valem para os demais worktrees.
