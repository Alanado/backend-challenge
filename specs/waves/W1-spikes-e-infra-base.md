# W1 — Spikes e infra base

**Slot:** terça noite / quarta manhã (trilha A, **em paralelo com W2**) · **Branch:** `wave/w1` em worktree `../backend-challenge-w1` · **Depende de:** W0 · **Libera:** W3 · **Tamanho:** M

## Prompt (cole na sessão)

```text
Você é a sessão executora da Onda W1 — Spikes e infra base do desafio Distributed Wagering Processor.
Trabalhe dentro do WSL, no worktree ~/projetos/backend-challenge-w1, branch wave/w1 (criada a partir da main após a W0).
Leia nesta ordem: CLAUDE.md, specs/README.md, specs/waves/_common.md e specs/waves/W1-spikes-e-infra-base.md. Depois leia somente a seção "Leitura" deste arquivo.
Execute APENAS as tarefas T-002, T-003, T-004, T-005a e T-006, nesta ordem, seguindo o protocolo de _common.md (testes/scripts reproduzíveis, um commit por tarefa, gate, provas de dentes, relatório).
Os spikes são bloqueantes: se R-01, R-02 ou R-03 falharem sem plano B viável, PARE e consulte o autor no formato Problema/Opções/Recomendação/Explicação.
Não altere specs nem ADRs (exceto o que as tarefas mandam criar: adr/0002-spike.md, CLAUDE.md). Ao final: rode o gate, escreva specs/waves/reports/W1-report.md e informe o veredito com a evidência.
```

## Leitura

[00-overview.md](../00-overview.md) §6 (riscos R-01..R-06) · [ADR-0002](../adr/0002-stack-bun-nestjs-mikroorm.md) · [ADR-0015](../adr/0015-inbox-consumidor-e-resiliencia.md) (semântica FIFO/DLQ que o emulador precisa honrar) · [ADR-0018](../adr/0018-observabilidade.md) · [ADR-0019](../adr/0019-estrategia-de-testes.md) · [ADR-0020](../adr/0020-ferramentas-e-validacao.md) · [03-messaging.md](../03-messaging.md) §1 e §3.4 · [02-design.md](../02-design.md) §7–§9 · [05-test-plan.md](../05-test-plan.md) §2 · [06-tasks.md](../06-tasks.md) (M0).

## Pré-condições

`bun run typecheck && bun run lint && bun run test:unit` verdes na `main`; `docker ps` responde; `docker compose version` ok.

## Convenção dos spikes (fronteira N12)

Cada spike deixa **(a)** um script executável em `spikes/<nome>/` (com um script `bun run spike:<nome>` no `package.json`) que **prova** cada item da checklist e sai com código ≠ 0 se algum falhar, e **(b)** uma seção em `specs/adr/0002-spike.md` com versões exatas, resultado de cada item e decisões de fallback. Spike sem script reproduzível não conta como concluído.

## Tarefas

### T-002 — Spike R-02: Nest + MikroORM no Bun

Checklist (cada item é uma verificação do script):
1. Aplicação Nest sobe no Bun com `@mikro-orm/nestjs`; anote o adaptador HTTP que funciona (Express é o padrão; se só Fastify funcionar, **pare e pergunte**).
2. DI por tipo de construtor funciona com `emitDecoratorMetadata` (provider injetado sem `@Inject` explícito).
3. `em.transactional`: commit e rollback efetivos (prove com leitura em outra conexão).
4. `LockMode` pessimista: gera `FOR UPDATE`; o modo parcial gera `FOR UPDATE SKIP LOCKED`; prove com **duas conexões reais** (a segunda espera/falha/pula conforme o modo).
5. `SET LOCAL lock_timeout` e `statement_timeout` dentro da transação funcionam; o erro `55P03` chega ao código com o `code` acessível (descreva onde está: `err.code`, `err.cause.code`…). Idem `40P01` (dois `FOR UPDATE` cruzados) e `57014`.
6. **`numeric(19,2)` chega como string** e volta como string (ex.: `"12345678901234567.89"`), sem passar por `number`.
7. `EntitySchema` (sem decorators) mapeia uma tabela; migrator `up`/`down` funciona com uma migration trivial; scripts `migration:up` / `migration:down` / `migration:create` definidos.
8. Versões exatas de Bun, Nest, MikroORM, `@mikro-orm/nestjs`, `pg` e da imagem do Postgres registradas em `adr/0002-spike.md`.

**Parada obrigatória:** se (1)–(4) não funcionarem e o plano B (versão anterior do MikroORM) também falhar, pare e consulte o autor antes de seguir.

### T-003 — Spike R-01/R-03: emulador SQS sem token + AWS SDK v3 no Bun

Escolha o emulador **sem exigir auth token**: LocalStack fixado em tag anterior a 2026.03 (confirme a tag), ou MiniStack. **Token nunca no caminho padrão.** Fixe a imagem por tag (e digest, se possível). Checklist:
1. `@aws-sdk/client-sqs` v3 funciona no Bun (`SendMessage`, `SendMessageBatch`, `ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility`, `GetQueueAttributes`).
2. Fila FIFO + DLQ FIFO com `redrivePolicy` (`maxReceiveCount`); após N recebimentos sem delete a mensagem aparece na DLQ.
3. `MessageGroupId`: ordem preservada dentro do grupo; **bloqueio de cabeça de fila** (enquanto a mensagem do grupo está em voo, a seguinte do mesmo grupo não é entregue); grupos diferentes entregam em paralelo.
4. `MessageDeduplicationId`: duplicata dentro da janela não é entregue duas vezes.
5. `ReceiveMessage` com long polling (`WaitTimeSeconds`) e atributos `ApproximateReceiveCount` e `MessageGroupId`.
6. `ChangeMessageVisibility` com `0` devolve a mensagem imediatamente; com N segundos adia.
7. `SendMessageBatch` com falha parcial: uma entrada inválida (ex.: `MessageGroupId` com 129 caracteres) falha **sozinha**, as demais passam.
8. Fila inexistente: anote o código de erro exato retornado (insumo para classificar como transitório).
9. Tempo de subida e consumo de RAM do emulador.

**Parada obrigatória:** se nenhum emulador sem token honrar (2)–(6), **pare e consulte o autor** (instrução explícita do T-003).

### T-004 — Spike R-04/R-05: prom-client, Biome, commitlint

1. `prom-client` no Bun: counter, gauge **e histogram** com labels, e `GET /metrics` servido (não só as métricas padrão do Node). Registre se as métricas padrão funcionam ou devem ficar desligadas.
2. **Biome:** confirme se `noFloatingPromises` existe na versão fixada (e em qual grupo); ative-a. Desligue `useImportType` (quebra a DI do Nest com `emitDecoratorMetadata`), **documentando o motivo no `biome.json`/ADR do spike**. Prove com um fixture que uma promise solta **falha** o `lint`.
3. **commitlint:** `@commitlint/cli` + `config-conventional` rodando sob Bun; hook `commit-msg` versionado (ex.: `.githooks/` + `core.hooksPath` definido por um script `prepare`/`hooks:install`), **sem Husky global**. Prove: mensagem inválida é **rejeitada**, mensagem válida é **aceita**. Mensagens **não** levam trailer `Co-Authored-By` (regra do projeto). As descrições dos commits são em **português** (com acentos): confirme que `config-conventional` as aceita (por exemplo `feat(wallet): adiciona value object Money (T-010)`) e ajuste só o necessário, sem desligar regras que protejam o formato (`type-enum`, `type-empty`, `subject-empty`).
4. Se o Biome não cobrir `noFloatingPromises`, aceite a lacuna e documente (plano B do R-05).

### T-005a — Compose de infra + script de filas

- `docker-compose.test.yml` e `docker-compose.yml` **somente com Postgres (versão fixa) e o emulador escolhido em T-003**. Sem serviços `app` (isso é T-005b, na W10). Healthchecks nos dois.
- Postgres pensado para testes: `max_connections` folgado (dezenas de suítes e instâncias), `fsync=off` apenas no compose **de teste** (documente).
- Script idempotente (`scripts/create-queues.ts`, via SDK) que cria `wager-transactions.fifo` (visibilidade 30 s, long polling 20 s, redrive `maxReceiveCount=8` para a DLQ), `wager-transactions-dlq.fifo` e `wager-events.fifo` ([02-design §9](../02-design.md)). Rodar duas vezes não falha nem altera nada.
- Scripts `test:infra:up` (sobe, espera healthy, cria filas) e `test:infra:down`.
- **Teste de fumaça de infra** `test/integration/infra.smoke.test.ts` (Postgres e SQS **reais**): conecta, `SELECT 1`, as três filas existem, a principal tem `RedrivePolicy` com `maxReceiveCount=8` apontando para a DLQ.
- Meça a RAM (`docker stats --no-stream`, `free -m`) com a base de pé e registre em `adr/0002-spike.md` (R-06).

### T-006 — `CLAUDE.md` com comandos reais

- Atualize a seção "Comandos" do `CLAUDE.md` com os scripts que **realmente existem** e funcionam (os nomes-contrato que ainda não existem continuam marcados como "a criar na T-xxx").
- Commitlint e Biome ativos: um commit de teste com mensagem inválida precisa ser barrado (evidência no relatório; não deixe esse commit no histórico).
- Em `06-tasks.md`, acrescente **apenas** um ponteiro "Resultados do spike: ver `adr/0002-spike.md`" e marque as tarefas. Se o resultado do spike implicar mudar alguma tarefa, ADR ou spec, **pare e pergunte**; não edite.
- `adr/0002-spike.md` completo (versões, resultados por item, decisões de fallback, RAM).

## Gate

| # | Verificação | Esperado |
|---|---|---|
| 1 | `bun install --frozen-lockfile` · `typecheck` · `lint` | limpos |
| 2 | `bun run test:infra:up` rodado **duas vezes seguidas** | ok nas duas (idempotente) |
| 3 | `bun run spike:<nome>` de cada spike (T-002, T-003, T-004) | exit 0, cada item da checklist reportado |
| 4 | `bun run test:unit` e `bun test test/integration/infra.smoke.test.ts` (3×) | verdes |
| 5 | Hook de commit | mensagem inválida barrada, válida aceita (saída colada) |
| 6 | Fixture de promise solta | `lint` falha (saída colada) |
| 7 | `adr/0002-spike.md` | versões exatas + resultado de cada item + RAM medida |
| 8 | `bun run test:infra:down` | ok |

**Provas de dentes:** tire o `redrivePolicy` do script de filas → o smoke de infra fica vermelho; desative `noFloatingPromises` → o teste do fixture fica vermelho; sabote o hook → o teste de commit inválido deixa de ser barrado. Restaure tudo.

## Pare e pergunte se

R-01, R-02 ou R-03 falharem sem plano B (instrução explícita); Express não subir no Bun; o emulador exigir token; o resultado do spike contrariar um ADR; qualquer tarefa pedir mais de um commit.

## Fora do escopo

Entidades reais, migrations do schema, config Zod, módulo de infra (W3); `Dockerfile` e serviços `app` (T-005b, W10); logs/métricas reais (W5).

## Entregáveis

5 commits (T-002, T-003, T-004, T-005a, T-006) + relatório · `spikes/` · `adr/0002-spike.md` · compose + script de filas. **Mergear na `main`** antes da W3 (ver [07-waves.md §5](../07-waves.md)).
