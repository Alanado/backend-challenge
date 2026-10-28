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
