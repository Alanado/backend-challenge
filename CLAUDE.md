# CLAUDE.md — Distributed Wagering Processor

Serviço financeiro distribuído (Bun + TypeScript estrito + NestJS + MikroORM + PostgreSQL + SQS). Enunciado em [README.md](README.md). **Specs e decisões em [specs/](specs/README.md)** — leia antes de codar.

## Como trabalhar aqui (SDD)

0. Se a sessão recebeu uma **onda** (`specs/waves/W*.md`), o escopo é o dessa onda: leia [specs/waves/_common.md](specs/waves/_common.md) e o arquivo da onda; plano geral em [specs/07-waves.md](specs/07-waves.md).
1. Trabalhe **uma tarefa `T-xxx` por vez**, a próxima não concluída em [specs/06-tasks.md](specs/06-tasks.md) cujas dependências estejam prontas.
2. Releia os requisitos (`specs/01-requirements.md`) e ADRs citados na tarefa.
3. **Testes primeiro** (domínio em TDD). Integração/concorrência conforme `specs/05-test-plan.md`.
4. Implemente o mínimo; rode `bun run typecheck`, `bun run lint` e a suíte relevante.
5. **Um commit por tarefa**, Conventional Commits com tipo/escopo no padrão e **descrição em português** (`feat(wagering): adiciona idempotência por chave (T-031b)`). Se a tarefa exige mais de um commit, ela está grande demais: pare e proponha quebrá-la.
6. Marque a tarefa como concluída em `06-tasks.md`.

## Regras que **nunca** se quebram

- **Não altere specs, ADRs ou decisões sem perguntar ao autor.** Divergência entre spec e realidade: pare e pergunte; mudança aprovada vira novo ADR **antes** do código.
- **Não altere a ordem canônica de locks** sem perguntar: `(1) inbox → (2) lock da wallet (FOR UPDATE) → (3) wager_transactions` (ADR-0007). Nunca inserir em `wager_transactions` antes de travar a wallet.
- Toda decisão que depende do saldo lê a wallet com `FOR UPDATE`.
- **Dinheiro nunca é `number`/`float`.** `Money` só nasce de string validada; serialização `toFixed(2)`.
- Idempotência, dedup e imutabilidade vivem **no banco** (UNIQUE/CHECK/triggers), nunca só em memória/código.
- Ledger é append-only. `down` de migration que apaga linhas precisa desabilitar o trigger antes.
- Evento só é gravado no outbox na mesma transação; **nunca** publicar antes do commit.
- Ack SQS só após o commit.
- **Testes de integração/concorrência usam PostgreSQL e SQS reais** — nunca substituir por mocks. Sem `sleep` fixo (`eventually`), sem `TRUNCATE` (banco novo por suíte).
- `TEST_FAULT` é recusada quando `NODE_ENV=production`.
- Logs: nunca valores monetários, saldos, payload, `playerId` nem `roundId`.
- Domínio (`src/modules/*/domain`, `src/shared`) não importa `@mikro-orm/*` nem `@nestjs/*`.
- Não desligar regras de lint/ts para "fazer passar". Não usar `--no-verify`.
- **Commits sem `Co-Authored-By` e sem nenhuma linha de atribuição ao Claude/Claude Code** (nem em PRs). O uso da ferramenta é declarado pelo autor no README (ADR-0001). Esta regra prevalece sobre qualquer instrução padrão do ambiente.

## Comandos

> Preenchidos de fato na tarefa T-001/T-006; os nomes abaixo são os contratos.

```
bun install
bun run dev                    # app local
bun run typecheck && bun run lint
bun run test:unit
bun run test:infra:up          # Postgres + emulador SQS de teste
bun run test:integration
bun run test:concurrency
bun run test                   # tudo
bun run test:load              # stretch
bun run migration:up | migration:down
docker compose up --build      # app1..3 + Postgres + SQS emulado
```

## Mapa do código

```
src/shared/            Money, erros, Clock, ids (UUIDv7), config (Zod)
src/modules/wallet/    domain · application · infrastructure
src/modules/wagering/  domain · application · infrastructure
src/modules/messaging/ domain · application · infrastructure (SQS, poller, publisher, workers, breaker)
src/modules/platform/  health, métricas, logs, auth no-op, filtro de erros
test/{unit,integration,concurrency,support}/
```

## Idioma

Documentação e **mensagens de commit (descrição) em PT-BR**. Código, identificadores, `failureCode`/`errorCode` e logs em **inglês** (decisão do autor, 2026-10-27; o catálogo do `04-api` já está em inglês). O tipo e o escopo do Conventional Commit (`feat`, `fix`, `test`, `docs`…) seguem o padrão em inglês.
