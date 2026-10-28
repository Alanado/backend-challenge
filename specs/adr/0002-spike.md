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
