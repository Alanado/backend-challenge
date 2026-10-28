# ADR-0002 — Stack: Bun, NestJS, MikroORM, PostgreSQL, SQS

- **Status:** Aceita (sujeita ao spike T-002/T-003) · **Data:** 2026-10-27 · **Relacionados:** R-01, R-02, R-03

## Contexto
O enunciado fixa Bun 1.x, TypeScript estrito, NestJS, PostgreSQL, SQS via LocalStack/MiniStack, Docker Compose e migrations reversíveis. ORM: MikroORM (preferencial) ou TypeORM; Prisma fora de escopo.

## Opções consideradas (ORM)
| Opção | Prós | Contras |
|---|---|---|
| **MikroORM** | Preferencial no enunciado; Unit of Work e Identity Map explícitos; `transactional()`, `LockMode` (inclui `SKIP LOCKED`); migrator com `up/down`; `EntitySchema` sem decorators | Menos familiar ao autor; integração com Bun a validar |
| TypeORM | Aceito; mais conhecido | `LockMode` e migrations menos ergonômicos; Identity Map ausente |

## Decisão
MikroORM, na **versão mais recente que o `@mikro-orm/nestjs` suporte sem gambiarras** sob Bun, definida no spike T-002 e registrada em `adr/0002-spike.md`. Plano B: versão anterior do MikroORM; último recurso, TypeORM. SQL cru parametrizado é permitido onde o ORM não expressa bem (por exemplo `SELECT … FOR UPDATE SKIP LOCKED`, reconciliação em snapshot).

Bun suporta `emitDecoratorMetadata` desde o 1.0.3, então a injeção de dependência do NestJS por tipo deve funcionar (validar no spike).

**Emulador SQS (R-01):** a imagem `localstack/localstack` exige auth token a partir de 2026.03.0 (plano gratuito só para uso não comercial). O padrão do projeto **não pode depender de token**: usar tag do LocalStack anterior a 2026.03 ou MiniStack (permitido pelo enunciado), o que passar na validação de FIFO, `MessageGroupId`, deduplicação, DLQ FIFO e redrive.

## Consequências
- (+) Alinhado ao enunciado e ao stack da empresa.
- (−) Três integrações a validar no Bun (MikroORM+Nest, AWS SDK, emulador); o spike do Dia 1 é bloqueante.
