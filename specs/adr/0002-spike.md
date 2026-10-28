# ADR-0002 (adendo) — Resultados dos spikes R-01..R-06

- **Status:** em preenchimento pela W1 · **Data:** 2026-10-28 · **Relacionados:** ADR-0002, ADR-0015, ADR-0018, ADR-0019, ADR-0020, R-01..R-06
- Cada spike tem um script reproduzível (`bun run spike:<nome>`) que sai com código ≠ 0 se um item falhar. Pré-requisito dos spikes que usam banco/fila: `bun run test:infra:up`.

## T-002 — R-02: NestJS + MikroORM no Bun

Script: `bun run spike:nest-mikro` ([spikes/nest-mikro/main.ts](../../spikes/nest-mikro/main.ts)). Resultado: **14/14 verificações ok**; R-02 **não bloqueia**, sem necessidade de plano B (versão anterior do MikroORM ou TypeORM).

### Versões exatas

| Componente | Versão |
|---|---|
| Bun | 1.4.4 |
| `@nestjs/core` / `@nestjs/common` / `@nestjs/platform-express` | 12.3.2 |
| `@mikro-orm/core` / `postgresql` / `migrations` | 7.2.5 |
| `@mikro-orm/nestjs` | 7.1.0 (peer: Nest ^11 ou ^12, MikroORM ^7) |
| `pg` | 8.23.1 |
| `reflect-metadata` / `rxjs` | 0.2.2 / 7.8.2 |
| Imagem do Postgres | `postgres:17.6-alpine` (PostgreSQL 17.6) |

### Resultado por item

| # | Item | Resultado |
|---|---|---|
| 1 | Nest sobe com `@mikro-orm/nestjs` | ok. **Adaptador HTTP: Express** (`@nestjs/platform-express`), `GET /ping` responde 200. Fastify não foi necessário |
| 2 | DI por tipo sem `@Inject` | ok com `emitDecoratorMetadata` (`PingController` ← `AccountService` ← `EntityManager`) |
| 3 | `em.transactional` | ok. Outra conexão (`pg`) não vê dado não commitado; commit visível ao final; rollback desfeito |
| 4 | `LockMode` | `PESSIMISTIC_WRITE` → `… for update`; `PESSIMISTIC_PARTIAL_WRITE` → `… for update skip locked`; `PESSIMISTIC_WRITE_OR_FAIL` → `NOWAIT`. Com duas conexões reais: `FOR UPDATE` esperou até o `lock_timeout` (≈430 ms para 400 ms) e falhou com `55P03`; `SKIP LOCKED` devolveu só a linha livre em ≈30 ms; `NOWAIT` falhou na hora |
| 5 | `SET LOCAL lock_timeout` / `statement_timeout`; códigos | ok via `tx.execute("set local …")`; o `SET LOCAL` não vaza para fora da transação. **O SQLSTATE está em `err.code`** (string) nos três casos: `55P03` (classe `DriverException`), `40P01` (classe `DeadlockException`), `57014` (classe `DriverException`). Não é preciso olhar `err.cause`; o classificador deve ler `err.code` |
| 6 | `numeric(19,2)` como string | ok. `"12345678901234567.89"` (17 dígitos inteiros, além de 2^53) volta idêntico pela entidade (`type: "string"`, `columnType: "numeric(19,2)"`), por `em.execute` e pelo `pg`; `typeof` é `string` em todos |
| 7 | `EntitySchema` e migrator | ok. `EntitySchema` sem decorators lê a tabela. `migration:up`, `migration:down` e `migration:create` (scripts em [scripts/migrate.ts](../../scripts/migrate.ts), variáveis `DATABASE_URL` e `MIGRATIONS_PATH`) aplicam, revertem e geram uma migration trivial |
| 8 | Versões | tabela acima |

### Particularidades da v7 (para as próximas ondas)

- O migrator é uma **extensão**: `extensions: [Migrator]` (de `@mikro-orm/migrations`) e acesso por `orm.migrator` (propriedade, não `getMigrator()`).
- `em.execute` usa placeholders `?`.
- `PESSIMISTIC_WRITE` em `findOne` só funciona dentro de transação (`em.transactional`).
- O módulo `@mikro-orm/nestjs` expõe `EntityManager` do pacote do driver (`@mikro-orm/postgresql`) injetável por tipo.

## T-003 — R-01/R-03: emulador SQS sem token + AWS SDK v3 no Bun

Script: `bun run spike:sqs` ([spikes/sqs/main.ts](../../spikes/sqs/main.ts); endpoint em `SPIKE_SQS_ENDPOINT`, padrão `http://localhost:4567`, o do compose de teste). Resultado: **11/11 verificações ok** no LocalStack 4.14.0; R-01 e R-03 **não bloqueiam**.

### Escolha do emulador

| Candidato | Imagem | Sem token | Resultado do spike |
|---|---|---|---|
| **LocalStack** (escolhido) | `localstack/localstack:4.14.0` (`sha256:3ebc37595918b8accb852f8048fef2aff047d465167edd655528065b07bc364a`), build de 2026-02-26, **última tag anterior a 2026.03** (a `2026.03.0` é de 2026-03-23) | sim: nenhuma variável de token; o log só exibe um aviso informativo sobre a unificação de março de 2026 | **11/11** |
| MiniStack | `ministackorg/ministack:1.5.33` (`sha256:b58186186515a372798ccf0ca9975c295db219b5a811975337d6967b968e07b4`) | sim | **10/11**: falha o item 7 (aceita `MessageGroupId` com 129 caracteres: `Successful=bad,ok1,ok2`) |

O MiniStack é mais leve, mas não valida limites de parâmetro que o SQS real valida, o que enfraquece os testes de erro. O LocalStack é o padrão do projeto (ADR-0002); o MiniStack fica como plano B documentado. **Token nunca no caminho padrão**: o compose não define `LOCALSTACK_AUTH_TOKEN`. Fixar por tag **e** digest.

### Versões

| Componente | Versão |
|---|---|
| `@aws-sdk/client-sqs` | 3.1158.0 |
| Bun | 1.4.4 |
| Emulador | LocalStack 4.14.0 (`SERVICES=sqs`) |

### Resultado por item (LocalStack 4.14.0)

| # | Item | Resultado |
|---|---|---|
| 1 | SDK v3 no Bun | ok: `SendMessage`, `SendMessageBatch`, `ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility`, `GetQueueAttributes` |
| 2 | FIFO + DLQ FIFO com `RedrivePolicy` | ok. Com `maxReceiveCount=2`, a mensagem é recebida 2× (`ApproximateReceiveCount` 1, 2); na tentativa seguinte vai para a DLQ FIFO. A policy lida de volta traz `maxReceiveCount` e o ARN da DLQ |
| 3 | `MessageGroupId` | ordem preservada (`a1..a5`). **Bloqueio de cabeça de fila**: com `a1` em voo, `a2` não é entregue, o grupo B entrega em paralelo, e `a2` é liberada após o `DeleteMessage` de `a1`. Informativo: **um único `ReceiveMessage` devolve várias mensagens do mesmo grupo** (3 de 3, em ordem), logo o agrupamento por `MessageGroupId` dentro do lote do poller (03-messaging §3.4) é necessário e correto |
| 4 | `MessageDeduplicationId` | 2 envios, 1 entrega; os dois envios devolvem o mesmo `MessageId` |
| 5 | Long polling e atributos | fila vazia com `WaitTimeSeconds=2` espera ≈2,0 s; com mensagem enviada durante a espera, acorda em ≈0,5 s. `ApproximateReceiveCount` e `MessageGroupId` chegam em `Attributes` quando pedidos em `MessageSystemAttributeNames` |
| 6 | `ChangeMessageVisibility` | `0` devolve na hora (`ApproximateReceiveCount` sobe para 2); `3` adia ≈3,2 s |
| 7 | `SendMessageBatch` parcial | `MessageGroupId` de 129 caracteres falha **sozinho**: `Failed=[{Id: "bad", Code: "InvalidParameterValueException", SenderFault: true}]`; as demais passam |
| 8 | Fila inexistente | **todas as operações** (`GetQueueUrl`, `ReceiveMessage`, `SendMessage`, `GetQueueAttributes`) falham com `err.name = "QueueDoesNotExist"`, `err.Code = "AWS.SimpleQueueService.NonExistentQueue"`, HTTP 400, `$fault = "client"`. **Insumo para a classificação:** `$fault = "client"` não pode ser usado sozinho para decidir "permanente"; fila inexistente (ex.: ainda não criada no boot) deve ser tratada como **erro de infraestrutura/transitório** e reportada no readiness (ADR-0018), classificando por `err.name === "QueueDoesNotExist"` |
| 9 | Tempo de subida e RAM | ≈3,4 s até `sqs: available` (imagem local); ≈98 MiB ocioso, ≈128 MiB após o spike. (MiniStack: ≈2,7 s e ≈38–45 MiB) |

### Particularidades

- A imagem do LocalStack tem 1,77 GB (MiniStack: 258 MB); o primeiro `pull` é demorado.
- Região e credenciais podem ser fictícias (`us-east-1`, `test`/`test`).

## T-004 — R-04/R-05: prom-client, Biome e commitlint

Script: `bun run spike:tooling` ([spikes/tooling/main.ts](../../spikes/tooling/main.ts)). Resultado: **4/4 itens ok**; R-04 e R-05 **não bloqueiam**. Os itens 2 e 3 são provados por testes de verdade (`test/unit/tooling/lint-rules.test.ts`, `commit-msg-hook.test.ts`), que o script executa; eles também rodam em `bun run test:unit`.

### Versões

| Componente | Versão |
|---|---|
| `prom-client` | 15.1.3 |
| `@biomejs/biome` | 2.6.3 |
| `@commitlint/cli` / `@commitlint/config-conventional` | 21.2.4 / 21.2.4 |

### prom-client (R-04)

| Item | Resultado |
|---|---|
| Counter, gauge e histogram com labels, servidos em `GET /metrics` | ok (`Registry#metrics()`, `Content-Type: text/plain; version=0.0.4`; buckets, `_count` e `_sum` corretos) |
| Métricas padrão (`collectDefaultMetrics`) | registram 31 séries sem erro, mas **só parte é confiável sob o Bun**: `process_cpu_*`, `process_resident_memory_bytes`, `process_open_fds` e `nodejs_heap_size_*` têm valores reais; `nodejs_eventloop_lag_seconds` fica sempre `0`, `nodejs_gc_duration_seconds` fica **vazio** e `nodejs_active_handles_total`/`_requests_total` ficam `0` |

**Decisão (fallback do R-04, sem mudar ADR):** as métricas de negócio (ADR-0018) usam contadores/gauges/histogramas próprios. Ligar `collectDefaultMetrics` é opcional e só o grupo `process_*`/heap deve ser tratado como informação; **não** usar event loop lag, GC nem handles como sinal.

### Biome (R-05)

- `noFloatingPromises` **existe** na 2.6.3, no grupo **`nursery`** (`lint/nursery/noFloatingPromises`; severidade padrão `info`, por isso foi elevada a `"error"`). Usa inferência de tipos do Biome (domínio `types`): detecta uma promise solta de função `async` declarada no mesmo arquivo. A regra está no grupo nursery, então pode mudar de nome/grupo em versão futura; a versão do Biome é fixa (2.6.3).
- Prova (fixture): uma chamada `save();` sem `await`/`void`/`.catch` **falha** o lint com `lint/nursery/noFloatingPromises`; `await`, `void` e `.catch(() => …)` passam (`test/support/fixtures/lint/*.ts.txt`, rodados com a configuração real do repositório).
- `useImportType` **desligada** em `style`. Motivo (comentário no arquivo de configuração): com `emitDecoratorMetadata`, `import type` apaga o token de DI do Nest e a injeção por tipo de construtor falha em runtime. Prova no teste: com a regra ligada o Biome sinaliza o import do `@Injectable()` (`All these imports are only used as types`); com ela desligada, passa.
- O arquivo de configuração passou de `biome.json` para **`biome.jsonc`** porque `biome.json` não aceita comentários. As specs ainda citam `biome.json`; a referência é o `biome.jsonc`.
- O plano B do R-05 (aceitar a lacuna) **não foi necessário**.

### commitlint (R-05)

- `@commitlint/cli` roda sob Bun (`bun run --silent commitlint --edit <arquivo>`). Hook versionado em [.githooks/commit-msg](../../.githooks/commit-msg) (adiciona `~/.bun/bin` ao `PATH`, pois hooks podem rodar sem o `PATH` do shell interativo); instalado por `bun run hooks:install` (`git config core.hooksPath .githooks`), que também roda no `prepare` do `bun install`. **Sem Husky.** O `core.hooksPath` vai para o `.git/config` comum, valendo para todos os worktrees.
- `config-conventional` **aceita** descrições em português com acentos (`feat(wallet): adiciona validação de saldo e conciliação (T-010)`; `feat(wagering): adiciona idempotência por chave (T-031b)`) **sem ajuste**: nenhuma regra foi desligada nem alterada (`type-enum`, `type-empty`, `subject-empty`, `subject-case`, `subject-full-stop` seguem ativas e foram provadas rejeitando).
- Única adição: a regra local `no-co-authored-by` (em `commitlint.config.mjs`) que rejeita trailer `Co-Authored-By` e linha de atribuição à ferramenta, para impor por máquina a regra do CLAUDE.md/ADR-0001.
- Atenção para o autor: `body-max-line-length` (100) e `footer-leading-blank` continuam ativas; corpos de commit com linhas longas são rejeitados.

## T-005a — Compose de infra e RAM da base (R-06)

- [docker-compose.test.yml](../../docker-compose.test.yml) (projeto `wagering-test`; Postgres em `5433`, SQS em `4567`) e [docker-compose.yml](../../docker-compose.yml) (projeto `wagering`; `5432` e `4566`, dados em volume) contêm **somente** Postgres e emulador; os serviços `app1..3` entram na T-005b (W10). Os dois têm healthcheck (`pg_isready`; saúde do SQS em `/_localstack/health`).
- Imagens fixadas por **tag e digest**: `postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94` e `localstack/localstack:4.14.0@sha256:3ebc37595918b8accb852f8048fef2aff047d465167edd655528065b07bc364a`. Sem `LOCALSTACK_AUTH_TOKEN` em lugar nenhum.
- **Postgres de teste:** `max_connections=300`; `fsync=off`, `synchronous_commit=off`, `full_page_writes=off` e dados em `tmpfs` **somente no compose de teste** (durabilidade é irrelevante lá e acelera `CREATE DATABASE … TEMPLATE`; documentado no próprio arquivo). O compose de desenvolvimento mantém a durabilidade padrão e `max_connections=200`.
- **Armadilha do healthcheck do LocalStack:** o estado do serviço em `/_localstack/health` muda de `available` para `running` depois do primeiro uso; o healthcheck aceita os dois (com apenas `available`, o contêiner viraria `unhealthy` após ~60 s de uso).
- [scripts/create-queues.ts](../../scripts/create-queues.ts) cria `wager-transactions-dlq.fifo`, `wager-transactions.fifo` (visibilidade 30 s, long polling 20 s, `RedrivePolicy` com `maxReceiveCount=8` para a DLQ) e `wager-events.fifo`; converge atributos por comparação e imprime `created` / `updated` / `unchanged`. Segunda execução: `unchanged` ×3, sem alterar nada (provado em `INFRA-05`). `SQS_ENDPOINT` seleciona o emulador.
- Scripts: `test:infra:up` (compose `up -d --wait` + criação das filas; ≈7 s com as imagens já baixadas), `test:infra:down` (`down -v`), `queues:create`. Smoke: `test/integration/infra.smoke.test.ts` (5 testes; Postgres e SQS reais).

### RAM com a base de pé (R-06), medida com `docker stats --no-stream` após o smoke

| Contêiner | Memória |
|---|---|
| Postgres 17.6 (tmpfs, ocioso) | ≈75 MiB |
| LocalStack 4.14.0 (SQS) | ≈127 MiB |
| **Total da base** | **≈202 MiB** de 7,75 GiB |

`free -m` no WSL: `used` 2172 MiB com a base de pé (a máquina já tinha ≈1,7 GB em uso antes de subir os contêineres; `buff/cache` inclui as imagens). A base cabe com enorme folga; o orçamento crítico de R-06 passa a ser as 3 instâncias da aplicação e os testes (medir na T-005b, W10).

## T-005b — Compose completo e RAM (R-06)

- [Dockerfile](../../Dockerfile): `oven/bun:1.4.4-slim` fixada por tag e digest (`sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4`); sem etapa de build (o Bun executa o TypeScript), `bun install --frozen-lockfile --production --ignore-scripts` (o `prepare` do projeto instala hooks do git, que não existem na imagem), usuário `bun`. A mesma imagem (`wagering-app:dev`) serve `app1..3` e `migrate`.
- **Quem roda as migrations (escolha reportada):** um serviço `migrate` **de uma execução só** (`restart: "no"`), que roda `migration:up` e `queues:create` e sai. `app1..3` têm `depends_on: migrate: condition: service_completed_successfully` (além de Postgres e SQS saudáveis), então as três instâncias nunca migram ao mesmo tempo e nunca sobem antes do schema e das filas. Alternativa descartada: migrar no boot de cada app (corrida de 3 migradores e acoplamento do app ao DDL).
- `app1..3`: portas 3001–3003 (`PORT` por serviço), `stop_grace_period: 30s`, `SHUTDOWN_GRACE_MS=20000`, `SHUTDOWN_DRAIN_DELAY_MS=2000`, healthcheck em `/health/ready`. `docker compose stop app1`: exit 0 em 2,7 s, com um 503 de readiness visível no log antes de `app_stopped`.
- `docker compose down -v && docker compose up --build -d --wait`: tudo `healthy` em 32 s (imagens já locais; o build do app é o único passo novo). `bun run compose:smoke` ([scripts/compose-smoke.ts](../../scripts/compose-smoke.ts)): wallet, um `BET` por cada instância, saldo `70.00` lido nas três, ledger com 4 lançamentos e reconciliação consistente; exit 0.

### RAM completa (R-06), WSL com 7,75 GiB para os contêineres

| Cenário | app1 | app2 | app3 | Postgres | SQS (LocalStack) | Soma |
|---|---|---|---|---|---|---|
| Ocioso, após o smoke | 97,7 MiB | 82,3 MiB | 82,8 MiB | 52,6 MiB | 137,1 MiB | ≈ 453 MiB |
| Durante uma rajada (amostra com mais memória) | 151,3 MiB | 139,6 MiB | 140,5 MiB | 124,6 MiB | 139,0 MiB | ≈ 695 MiB |
| Depois de duas rajadas (9 000 requisições `BET`, 0 respostas não 2xx, `deadlocks=0`) | 164,7 MiB | 159,5 MiB | 146,5 MiB | 151,8 MiB | 161,7 MiB | ≈ 784 MiB |

`free -m` (MiB, `used`): 4585 com a pilha ociosa e 4841 depois da rajada; a máquina já tinha ≈ 4,3 GB em uso antes de subir qualquer contêiner (`available` ≥ 3,1 GB durante a medição).

**Suíte de concorrência (3 processos Bun reais + Postgres e emulador de teste + o executor de testes):** pico de `used` = 4926 MiB (4313 MiB antes de começar, +613 MiB), soma do RSS de todos os processos `bun` ≤ 610 MiB, contêineres ≤ 327 MiB. Cabe em 8 GB com folga; R-06 não bloqueia.
