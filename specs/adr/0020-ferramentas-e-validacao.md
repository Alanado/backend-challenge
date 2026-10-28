# ADR-0020 — Validação, qualidade de código e commits

- **Status:** Aceita (Biome e commitlint sob Bun condicionados ao spike) · **Data:** 2026-10-27

## Decisão
- **Validação:** Zod, com **o mesmo schema para HTTP e SQS** (garante o mesmo contrato); variáveis de ambiente também validadas no boot com Zod. Alternativa descartada: `class-validator` (dois caminhos de validação). Swagger/OpenAPI fica no stretch (S-04).
- **TypeScript:** `strict` + `noUncheckedIndexedAccess`.
- **Lint/format:** Biome. Com `emitDecoratorMetadata`, a regra de import apenas de tipo (`useImportType`) quebra a injeção de dependência do Nest: **desligada e documentada**. Confirmar no spike que o Biome cobre `noFloatingPromises`; se não cobrir, aceitar a lacuna e documentar. Alternativa: ESLint + Prettier (mais configuração).
- **Commits:** Conventional Commits com `commitlint` e hook executado com Bun, sem depender de Husky global; um commit por tarefa `T-xxx`.
- **Estrutura:** `src/modules/{wallet,wagering,messaging,platform}` + `src/shared` (ADR-0003).
- **IDs:** UUIDv7 gerados na aplicação; timestamps `timestamptz` UTC; `snake_case`.

## Consequências
- (+) Contrato único de entrada; ferramentas rápidas. (−) Lacunas de lint possíveis, documentadas.
