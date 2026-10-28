# Relatório W6 — Núcleo financeiro

- Data/hora: 2026-10-28 12:36 (-03) · branch `wave/w6` (a partir da `main` com a W5, `cb8f4c1`) · HEAD das tarefas: `8ec2fd9`
- Veredito: **VERDE**

## Tarefas

| Tarefa | Commit | Testes que a fecham (ID → arquivo) | Vermelho → verde |
|---|---|---|---|
| T-031a Pipeline financeiro (`BET/WIN/LOSS`, `REJECTED`, ledger, outbox, gancho `fail-mid-transaction`) | `a013f59` | TST-I-06 e `X-LOCK-ORDER` → `test/integration/submit-wager-transaction.test.ts` (11 testes); TST-I-05 → mesmo arquivo (2 testes) | caso de uso esqueleto (`skeleton`): 13/13 falhavam; depois 13/13 verdes |
| T-031b Idempotência (fast path, replay, 409) | `1a6e373` | TST-I-07 → `test/integration/submit-idempotency.test.ts` (23 testes) | com a duplicata ainda em `DuplicateTransactionNotHandledYet`: 22 de 23 falhavam (o que passou foi "mesma chave, outro provedor", que é legitimamente uma operação distinta); depois 23/23 |
| T-032 Referências, reversões, `PENDING_REFERENCE`, acordar dependentes, backoff puro | `8ec2fd9` | TST-I-08 e TST-I-09 → `test/integration/submit-references.test.ts` (29 testes); TST-U-10 → `test/unit/wagering/reference-backoff.test.ts` (8 testes); `markPendingReference` com saldo observado → `test/unit/wagering/wager-transaction.test.ts` (+1) | integração: 29/29 falhavam (`ReferenceResolutionNotImplementedYet`); unit: o módulo `reference-backoff` não existia e o teste novo de `markPendingReference` falhava; depois 29/29 e 172/172 na pasta `wagering` |

Os três commits seguem Conventional Commits, sem `Co-Authored-By` e sem atribuição. O commit da T-031b foi emendado (`--amend`) uma vez, antes de qualquer publicação, para corrigir um erro de lint (ver "Desvios").

## Gate (saída real)

| Comando | Exit | Resumo |
|---|---|---|
| `git status` | — | limpo antes do gate |
| `bun install --frozen-lockfile` | 0 | 253 installs, sem mudanças |
| `bun run test:infra:up` | 0 | Postgres 5433 + SQS 4567, filas `unchanged` |
| `bun run typecheck` | 0 | limpo |
| `bun run lint` | 0 | 157 arquivos, sem erros nem warnings |
| `bun run test:unit` | 0 | 402 pass / 0 fail / 0 skip, 3,9 s |
| `bun run test:integration` ×3 | 0 | 315 pass / 0 fail / 0 skip nas três (17,3 s · 19,6 s · 18,5 s) |
| `bun run test:concurrency` | 0 | sem testes (passa vazio até a W7) |
| `grep` de skips (`test`, `src`) | — | nada |
| `grep -rn "NotImplementedYet" src` (também `NotHandledYet`) | — | nada |
| `grep -rnE "\bnumber\b" src/modules/*/application` | — | só `version`, contagens e `random`; nenhum dinheiro como `number` |
| `06-tasks.md` vs `main` | — | só T-031a, T-031b e T-032 passaram a `[x]` |

`assertLedgerInvariant` está no fim de todos os testes que tocam wallet (script que percorre cada `test(...)`); a única exceção é "wallet inexistente", que não tem wallet para checar.

## IDs de teste exigidos × encontrados

TST-I-05 ✔ · TST-I-06 ✔ · TST-I-07 ✔ · TST-I-08 ✔ · TST-I-09 ✔ · TST-U-10 ✔ · `X-LOCK-ORDER` ✔ (todos presentes em `test/`; nenhum ausente).

## Provas de dentes

Feitas no HEAD final (`8ec2fd9`), sem commitar, restaurando com `git checkout -- src test` e conferindo `git status` limpo e 63/63 verdes ao final. As provas de 1, 2 e 5 já tinham sido feitas no commit da T-031a e foram repetidas aqui porque o caso de uso mudou depois (fast path, referências).

| # | Mutação aplicada | Testes que falharam | Restaurado |
|---|---|---|---|
| 1 | `SELECT … FOR UPDATE` da wallet vira `SELECT` simples (`mikro-wallet.repository.ts`) | `X-LOCK-ORDER` + os 3 testes de releitura dentro da transação do TST-I-07 (4 falhas) | sim |
| 2 | `INSERT` em `wager_transactions` movido para antes do lock da wallet | `X-LOCK-ORDER`, "wallet inexistente" (TST-I-06) e os 3 de releitura do TST-I-07 (5 falhas) | sim |
| 3 | sem `ON CONFLICT DO NOTHING` + sem releitura (duas mutações juntas) | TST-I-07: conflito de id externo ×2, smoke de 10 em paralelo e os 3 de releitura (6 falhas) | sim |
| 4 | hash frouxo: `gameId` fora do `payloadHash` | TST-I-07 "mesma chave com `gameId` diferente" (1 falha; cada campo do hash tem o seu caso) | sim |
| 5a | pular o `INSERT` do outbox | TST-I-06 (24 falhas, incluindo os 5 de eventos exatos) | sim |
| 5b | falha injetada depois do commit | TST-I-05 (2 falhas) | sim |
| 6 | remover a checagem de "já revertida" (`existsProcessedReversalOf`) | TST-I-08 cenário-chave `BET→REFUND→ROLLBACK` e o inverso `ROLLBACK→REFUND` (2 falhas) | sim |
| 7 | remover o acordar dependentes | TST-I-09 "dependentes da wallet travada" e "LOSS acorda" (2 falhas) | sim |
| 8 | inverter a direção do `ROLLBACK` de `WIN` (CREDIT em vez de DEBIT) | TST-I-08 "ROLLBACK de WIN debita" e `REVERSAL_WOULD_OVERDRAW` (2 falhas) | sim |
| extra | `wakeDependents` sem o filtro de wallet | TST-I-09 "só a mesma wallet" (1 falha) | sim |

Nenhuma mutação sobreviveu.

## Desvios, decisões, dependências adicionadas

Dependências novas: nenhuma.

1. **Canal SQS fora do tipo.** `SubmissionContext.channel` é o literal `"http"` (não há ramo SQS nem placeholder em runtime). A T-042a alarga o tipo e acrescenta `messageId`/inbox. Assim o gate `NotImplementedYet` fica vazio sem esconder nada.
2. **`InsufficientFundsError` não é capturado no caso de uso.** A política da T-015 (`decideTransaction`) já decide `INSUFFICIENT_FUNDS` e `REVERSAL_WOULD_OVERDRAW` antes de aplicar, então o `catch` pedido no enunciado seria código morto. Se `wallet.debit` lançar depois da política aprovar, é bug: o erro sobe e a transação faz rollback.
3. **Alteração de domínio mínima:** `WagerTransaction.markPendingReference(nextAttemptAt, observedBalance?)` ganhou o parâmetro opcional para gravar `observed_balance` na entrada em `PENDING_REFERENCE` (exigido pela T-032 e pelo replay). Retrocompatível; teste unitário novo.
4. **Posição do gancho `fail-mid-transaction`:** depois de todas as escritas (UPDATE da wallet, ledger, UPDATE da transação, acordar dependentes, outbox) e antes do commit. Dispara em qualquer desfecho (rejeição, `LOSS`, pendente), não só quando há ledger, e o TST-I-05 cobre rejeição e `LOSS`.
5. **Fast path e a ordem de locks.** O `SELECT` do fast path em `wager_transactions` acontece antes do lock da wallet, como manda o ADR-0007 (leitura sem lock). O `X-LOCK-ORDER` aceita apenas `SELECT` simples sem `FOR …` em `wager_transactions` antes do lock; qualquer escrita ou lock ali reprova.
6. **Referência a si mesma:** uma `REFUND`/`ROLLBACK`/`WIN` cuja referência é o próprio `externalTransactionId` encontra a linha recém-inserida (`PENDING`) e cai em `REFERENCE_KIND_NOT_ALLOWED` antes de a política chegar ao caso `PENDING` (que lança). Coberto por teste.
7. **Releitura sem linha visível:** se o `INSERT` não inseriu e nenhuma releitura (chave ou id externo) acha linha, o caso de uso lança `Error` interno. Não vi forma de acontecer (as linhas nunca são apagadas); não é caso novo de regra, então não parei para perguntar.
8. **Observação para o autor (sem ação minha):** pela política da T-015, `REFERENCE_ALREADY_REVERSED` vale para qualquer comando com referência, inclusive `WIN`/`LOSS` que referenciam uma `BET` já revertida. O design §5 não distingue o tipo, e o caso de uso só repassa o fato. Não há teste dedicado a esse cruzamento.
9. **Suporte de teste novo:** `createPersistence({ onQuery })` captura o SQL que o MikroORM envia (usado no `X-LOCK-ORDER` e no teste "replay não trava"); `test/support/submit-harness.ts` (relógio manual, métricas e logger gravadores, injetor de falha). O teste de releitura dentro da transação é determinístico: uma segunda conexão segura o lock da wallet, o caso de uso passa pelo fast path e bloqueia, a conexão insere a linha "vencedora" e solta o lock (espera por `eventually` em `pg_stat_activity`, sem `sleep`). O smoke de 10 chamadas paralelas usa um pool de 14 para as chamadas realmente competirem.
10. **Lint no commit da T-031b.** O hook de commit só roda o commitlint, e a primeira versão do commit saiu com um erro de lint em `test/support/persistence.ts` (`noControlCharactersInRegex`, porque eu removia códigos ANSI com regex). Corrigi usando `Bun.stripANSI` (sem desligar a regra) e emendei o commit antes de qualquer publicação. A partir daí rodei `lint` com checagem do exit code antes de cada commit.
11. **Observações para a T-033 (W7):** `WagerTransaction.create` roda dentro da transação, depois do lock; combinações inválidas de `kind` × referência (`REFUND` sem referência, `BET` com referência) lançam `InvalidReferenceRequirementError` (domínio). O Zod de entrada precisa barrá-las antes (400) para não virarem 500. Mapeamentos esperados: `IdempotencyKeyPayloadMismatchError`/`ExternalTransactionIdConflictError` → 409; `WalletNotFoundError` → 404; `RequestValidationError` → 400; `TransientPersistenceError` → 503 (`lock_timeout`/`deadlock` já incrementam `lock_conflicts_total` no caso de uso).

## Perguntas em aberto / bloqueios

Nenhum bloqueio. Nenhuma pergunta ao autor pendente além da observação 8.

## Pré-condições da próxima onda verificadas

- `SubmitWagerTransaction` completo para o canal HTTP, com as dependências injetáveis por `SubmitWagerTransactionDeps` (`tm`, repositórios, `outbox`, `clock`, `ids`, `metrics`, `logger`, `faults`, `referenceBackoff`, `random?`). A W7 precisa registrá-lo num módulo Nest, passando `AppConfig.pendingRef` para `referenceBackoff` e o `FaultInjector` criado a partir de `config.testFault`.
- `referenceBackoff(attempt, config, random)` pronto e testado para a T-043.
- `WagerTransactionRepository.wakeDependents`/`existsProcessedReversalOf` já exercitados por testes de integração.
- Suíte verde 3× (315 integração, 402 unitários), infra de teste no ar, árvore limpa.
