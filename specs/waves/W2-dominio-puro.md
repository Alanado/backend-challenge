# W2 — Domínio puro

**Slot:** terça noite / quarta manhã (trilha B, **em paralelo com W1**) · **Branch:** `wave/w2` em worktree `../backend-challenge-w2` · **Depende de:** W0 · **Libera:** W4 (junto com W3) · **Tamanho:** M

## Prompt (cole na sessão)

```text
Você é a sessão executora da Onda W2 — Domínio puro do desafio Distributed Wagering Processor.
Trabalhe dentro do WSL, no worktree ~/projetos/backend-challenge-w2, branch wave/w2 (criada a partir da main após a W0).
Leia nesta ordem: CLAUDE.md, specs/README.md, specs/waves/_common.md e specs/waves/W2-dominio-puro.md. Depois leia somente a seção "Leitura" deste arquivo.
Execute APENAS as tarefas T-010 a T-016, nesta ordem, em TDD estrito (teste vermelho primeiro, depois implementação), um commit por tarefa, seguindo o protocolo de _common.md.
Não toque em infraestrutura, Nest, ORM, SQS ou banco: esta onda é domínio puro e roda sem Docker. Não altere specs nem ADRs. Em dúvida de regra, pare e pergunte no formato Problema/Opções/Recomendação/Explicação.
Ao final: rode o gate, escreva specs/waves/reports/W2-report.md e informe o veredito com a evidência.
```

## Leitura

[README do desafio](../../README.md) §6 (modelo de domínio, esqueletos de referência) e §7 · [01-requirements.md](../01-requirements.md) §1–§5 · [02-design.md](../02-design.md) §2, §3 e §5 (ordem de verificação das regras) · [03-messaging.md](../03-messaging.md) §6–§7 (outbox e eventos) · [04-api.md](../04-api.md) §4 (`failureCode`) e §6 (`payloadHash`) · [05-test-plan.md](../05-test-plan.md) §3 · [ADR-0004](../adr/0004-dominio-separado-da-persistencia.md) · [ADR-0005](../adr/0005-money-decimal.md) · [ADR-0008](../adr/0008-idempotencia.md) · [ADR-0009](../adr/0009-ledger-imutavel.md) · [ADR-0010](../adr/0010-reversao-unica-por-referencia.md) · [ADR-0011](../adr/0011-estados-e-codigos-de-falha.md) · [ADR-0013](../adr/0013-referencias-fora-de-ordem.md) · [ADR-0014](../adr/0014-outbox-e-eventos.md).

## Pré-condições

`main` com W0 (scaffold). `bun run typecheck && bun run lint && bun run test:unit` verdes. **Não precisa de Docker.** A trilha usa o Biome baseline da T-001 (a afinação da T-004 chega no merge).

## Regras da onda

- Nada fora de `src/shared`, `src/modules/{wallet,wagering,messaging}/domain` e `test/unit`. Sem `@mikro-orm/*`, `@nestjs/*`, `pg`, `@aws-sdk/*` (o teste de arquitetura T-016 vai provar).
- Construtores `private`/`protected` + fábricas estáticas (`create`, `from`, `open`, `rehydrate`); `rehydrate` **não** revalida transições.
- Tempo e ids entram por parâmetro/porta (`Clock`, gerador de ids): nada de `new Date()` nem `Date.now()` solto no domínio. UUIDv7 via `Bun.randomUUIDv7()` na implementação do gerador (sem dependência nova). `Clock` e gerador ficam em `src/shared`, criados na T-011 (fronteira N9).
- Única dependência de runtime permitida: `big.js` (+ `@types/big.js`), versão fixa. Zod só se uma tarefa realmente precisar (não precisa aqui).
- Erros de domínio herdam de uma base `DomainError` com `code` estável; cada tarefa cria só os erros de que precisa.
- Dúvida sobre regra do enunciado ou de ADR: pare e pergunte; **não invente** semântica.

## Tarefas

| Tarefa | Entrega | Testes que a fecham |
|---|---|---|
| **T-010** | `Money` (big.js, escala 2, parse estrito) + `DomainError`, `InvalidMoneyError`, `CurrencyMismatchError` | **TST-U-01, TST-U-02** |
| **T-011** | `Wallet` (`open`, `rehydrate`, `debit`, `credit`, `version`) + `WalletLedgerEntry` + `Clock` e gerador de ids | **TST-U-03, TST-U-07** |
| **T-012** | `WagerTransaction` (estados, transições, `ledgerDirectionFor`, `matchesPayload`) + enums `WagerTransactionKind/Status`, `LedgerDirection`, `FailureCode` (catálogo [04-api §4.1](../04-api.md)) | **TST-U-04**, parte de **TST-U-05** |
| **T-013** | `canonicalJson`, `sha256Hex`, `payloadHash` e `IdempotencyKey` | **TST-U-06** |
| **T-014** | `InboxMessage`, `OutboxMessage` (backoff, `isDue`), `IntegrationEvent` + os 5 eventos | **TST-U-08, TST-U-09** |
| **T-015** | Políticas puras de referência/reversão | restante de **TST-U-05** |
| **T-016** | Teste de arquitetura de imports | **TST-U-13** |

### Detalhes e armadilhas por tarefa

**T-010 Money.** Regex de entrada `^\d+\.\d{2}$`, máximo de 17 dígitos inteiros, moeda `^[A-Z]{3}$`. Rejeita `NaN`, `Infinity`, `1e3`, vazia, `1.234`, `1.5`, `-1.00` e `number` (o tipo de `from` só aceita string; teste com `as unknown as` para provar que um `number` em runtime é rejeitado). `from` **nunca** aceita negativo; `subtract`/`negate` podem produzir valor negativo em memória (necessário para `isNegative()` e para a checagem de saldo), e isso precisa estar coberto por teste e comentado. Use um construtor isolado do `big.js` (sem mutar a configuração global `Big.DP`/`Big.RM`). `toJSON()` e `toString()` sempre `toFixed(2)` (o `toString` do big.js pode sair em notação exponencial). Teste U-02 inclui varredura estática: nenhum `Number(`, `parseFloat`, `parseInt`, `toNumber`, `valueOf` numérico em `src/shared/money*`. Casos aritméticos clássicos (`0.10 + 0.20 === 0.30`). Imutabilidade: operações devolvem nova instância, original intacta.

**T-011 Wallet e ledger.** `debit(money, transactionId, now)` e `credit(...)` devolvem `WalletLedgerEntry` e atualizam saldo e `version` em conjunto; `debit` com saldo insuficiente lança `InsufficientFundsError` **sem** alterar nada; moeda diferente lança `CurrencyMismatchError`. `version` começa em 1 e só sobe quando o saldo muda (débito/crédito de valor > 0). `WalletLedgerEntry` inclui `walletVersion` (a versão da wallet logo após o lançamento; [ADR-0009](../adr/0009-ledger-imutavel.md)), sem setters; `create` valida `balanceBefore ± money === balanceAfter` e lança se desbalanceado; `isBalanced()`. `Wallet.open` com saldo inicial maior que zero começa em `version = 1`; a entrada `OPENING` (versão 1) é montada pelo caso de uso na T-030 via `WalletLedgerEntry.create`. Se isso não couber no modelo, **pare e pergunte**. `rehydrate` não revalida.

**T-012 WagerTransaction.** Campos do README §6.3 mais as extensões do [02-design §2](../02-design.md): `observedBalance`, `referenceAttempts`, `nextAttemptAt`. `create` nasce `PENDING` e valida a exigência de referência por kind (`REFUND`/`ROLLBACK` exigem; `BET`/`OPENING` proíbem; `WIN`/`LOSS` opcional). Transições válidas: `PENDING → PROCESSED | REJECTED | PENDING_REFERENCE | FAILED`; `PENDING_REFERENCE → PROCESSED | REJECTED | FAILED`; qualquer coisa a partir de terminal lança `InvalidTransactionStateError`. Uma nova tentativa que continua pendente **não é transição** (incrementa tentativas e reagenda). `ledgerDirectionFor(reference?)`: `OPENING/WIN/REFUND → CREDIT`, `BET → DEBIT`, `ROLLBACK` inverso da referência (`BET→CREDIT`, `WIN→DEBIT`, `REFUND→DEBIT`); `ROLLBACK` sem referência lança. `affectsBalance()` falso só para `LOSS`. `matchesPayload(hash)`. Tabela de transições coberta por teste parametrizado, **inclusive** o `rehydrate` de estados terminais sem lançar.

**T-013 Hash e chave.** Algoritmo exato do [04-api §6](../04-api.md): campos `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money{amount,currency}` e `referenceExternalTransactionId` (omitido se ausente); chaves ordenadas recursivamente, sem espaços, escape de `JSON.stringify`, UTF-8, SHA-256 hex minúsculo. `canonicalJson` e `sha256Hex` ficam reutilizáveis (o inbox da T-042a usa o mesmo, sobre o corpo inteiro da mensagem). Testes: **valor dourado fixo** (hash literal de um payload conhecido, para travar o algoritmo), invariância à ordem das chaves, sensibilidade a cada campo de negócio, campo opcional ausente × presente, metadados de transporte ignorados (a função só lê o subconjunto), amount normalizado. `IdempotencyKey`: 1–255 ASCII imprimíveis (P-8), default `{providerId}:{externalTransactionId}`; inválida lança erro de domínio.

**T-014 Inbox, outbox e eventos.** `OutboxMessage.scheduleRetry(now)`: backoff exponencial base 1 s, teto 60 s, **sem limite de tentativas**; `isDue(now)`, `markPublished(at)`; campos extras `groupKey`, `failedAt`, `lastError` ([02-design §2](../02-design.md)); `markFailed` para erro permanente. `InboxMessage.receive/markProcessed/isProcessed`. `IntegrationEvent<T>` abstrata; subclasses `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WagerTransactionFailed`, `WalletBalanceChanged`, cada uma com `eventType` e `version = 1` **no tipo**; `toJSON()` com `occurredAt` ISO-8601 e dinheiro como `MoneyProps` (string), nunca `Money`. `data` mínimos em [03-messaging §7](../03-messaging.md). `aggregateId` = id da transação (ou da wallet em `WalletBalanceChanged`); `causationId` = id da transação. Evite dependência circular entre domínios dos módulos: use tipos estruturais (interfaces) onde preciso.

**T-015 Políticas.** Funções puras (sem I/O) que recebem fatos já carregados e devolvem uma **decisão** tipada. Implemente a **ordem exata** do [02-design §5](../02-design.md): (1) player/moeda da wallet → `WALLET_PLAYER_MISMATCH`, `WALLET_CURRENCY_MISMATCH`; (2) referência: ausente → `PENDING_REFERENCE`; kind não permitido → `REFERENCE_KIND_NOT_ALLOWED`; wallet/player/moeda/rodada divergem → `REFERENCE_MISMATCH`; valor da reversão ≠ referência → `REVERSAL_AMOUNT_MISMATCH`; referência `PENDING_REFERENCE` → esta também pendente; referência `REJECTED`/`FAILED` → `REFERENCE_NOT_PROCESSED`; já revertida → `REFERENCE_ALREADY_REVERSED`; (3) saldo: `BET` sem saldo → `INSUFFICIENT_FUNDS`, reversão que ficaria negativa → `REVERSAL_WOULD_OVERDRAW`. Kinds permitidos: `REFUND→BET`; `ROLLBACK→BET|WIN|REFUND`; `WIN/LOSS→BET`. Testes table-driven cobrindo a matriz completa e **vários desvios simultâneos** (vence o primeiro da ordem).

**T-016 Arquitetura.** Varre os arquivos reais e falha se: algum arquivo em `src/shared` ou `src/modules/*/domain` importa `@mikro-orm/*` ou `@nestjs/*`; algum arquivo em `src/modules/*/application` importa de `infrastructure`. O teste **não pode ser vacuoso**: assevere que o número de arquivos varridos por regra é > 0 (nas pastas ainda vazias, a regra de `application` varre 0 arquivos agora; trate isso de forma explícita e documentada, sem desligar a regra). Cubra também o caso de import dinâmico e `import type` (decida e documente).

## Gate

| # | Verificação | Esperado |
|---|---|---|
| 1 | `bun install --frozen-lockfile` · `typecheck` · `lint` | limpos |
| 2 | `bun run test:unit` (3×) | verde, 0 skip |
| 3 | IDs exigidos | **TST-U-01, U-02, U-03, U-04, U-05, U-06, U-07, U-08, U-09, U-13** (todos presentes) |
| 4 | `bun test --coverage test/unit` | relatório anexado (sem limite numérico); liste arquivos de domínio com cobertura baixa |
| 5 | `grep -rnE "parseFloat|Number\(|toNumber" src/shared src/modules/*/domain` | nada relevante |
| 6 | `grep -rnE "@mikro-orm|@nestjs" src/shared src/modules/*/domain` | nada |
| 7 | Estatística de commits | 7 commits (T-010..T-016), cada um com teste vermelho antes (evidência no relatório) |

**Provas de dentes** (sem commitar): relaxar a regex de `Money` (aceitar `1.234`) → U-01; permitir saldo negativo no `debit` → U-03; permitir transição a partir de terminal → U-04; omitir um campo do hash → U-06; somar em vez de subtrair no débito do ledger → U-07; remover o teto do backoff → U-08; adicionar `import "@nestjs/common"` em um arquivo de domínio → U-13; trocar a ordem de duas checagens da política → U-05.

## Pare e pergunte se

Houver dúvida sobre sinal/negativos em `Money`, sobre quem cria a entrada `OPENING`, sobre campos do `WagerTransaction` além do README/design, ou sobre qualquer detalhe do `payloadHash`; ou se alguma tarefa pedir mais de um commit.

## Fora do escopo

Persistência, mappers, repositórios, use cases, Zod, Nest, logs/métricas, backoff de referências (TST-U-10, vai na T-032).

## Entregáveis

7 commits + relatório · domínio completo e testado. **Mergear na `main`** antes da W4.
