# Relatório W2 — Domínio puro

- Data: 2026-10-27 · branch `wave/w2` (worktree `~/projetos/backend-challenge-w2`, criado a partir da `main` @ `0cff7aa`) · HEAD: ver `git log` (7 commits de tarefa + este relatório)
- Veredito: **VERDE**

## Tarefas

| Tarefa | Commit | Testes que a fecham (ID → arquivo) | Vermelho → verde |
|---|---|---|---|
| T-010 | `3d730d7` | U-01, U-02 → `test/unit/shared/money.test.ts` | stub lançando `not implemented`: 43 fail / 2 pass (os 2 são do scaffold) → 47 pass |
| T-011 | `ad6ced0` | U-03 → `test/unit/wallet/wallet.test.ts`; U-07 → `test/unit/wallet/wallet-ledger-entry.test.ts`; `test/unit/shared/clock-ids.test.ts` | stubs com `not implemented`; contagem total do vermelho **não foi capturada** → 75 pass |
| T-012 | `a41dbaf` | U-04 e parte de U-05 → `test/unit/wagering/wager-transaction.test.ts` | 71 fail / 1 pass (catálogo de enum) → 147 pass |
| T-013 | `ec573b3` | U-06 → `test/unit/shared/hash.test.ts`, `test/unit/wagering/payload-hash.test.ts` | 41 fail / 0 pass → 188 pass |
| T-014 | `7be08a3` | U-08 → `test/unit/messaging/inbox-outbox.test.ts`; U-09 → `test/unit/messaging/integration-events.test.ts` | 25 fail / 0 pass → 213 pass |
| T-015 | `09a792b` | resto de U-05 → `test/unit/wagering/transaction-policy.test.ts` | 60 fail / 0 pass → 273 pass |
| T-016 | `e7fbda0` | U-13 → `test/unit/architecture.test.ts` (+ `test/support/architecture.ts`) | 31 fail / 0 pass → 308 pass |

Vermelho = o teste importava um stub que lança `not implemented` (ou não implementa a regra), nunca erro de import/sintaxe.

## Gate (saída real)

| Comando | Exit | Resumo |
|---|---|---|
| `git status` / `bun install --frozen-lockfile` | 0 | árvore limpa; "no changes" |
| `bun run typecheck` | 0 | limpo |
| `bun run lint` | 0 | 40 arquivos, sem erros/warnings |
| `bun run test:unit` ×3 | 0 | 308 pass / 0 fail / 0 skip nas 3 execuções (~55 ms) |
| `grep -rnE "\.(skip\|todo\|only)\b\|xit\(\|xdescribe\(" test src` | 1 | nada |
| `grep -rnE "parseFloat\|Number\(\|toNumber" src/shared src/modules/*/domain` | 1 | nada (a única `Number.isInteger/isFinite` não casa o padrão `Number(`) |
| `grep -rnE "@mikro-orm\|@nestjs" src/shared src/modules/*/domain` | 1 | nada |
| `grep -rnE "biome-ignore\|@ts-ignore\|@ts-expect-error\|: any\|as any" src test` | 1 | nada |
| `bun test --coverage test/unit` | 0 | All files: 99,31 % funções / 99,22 % linhas |

Cobertura baixa (sem limite numérico exigido): `wager-transaction.ts` 82,86 % funções / 92,86 % linhas (getters de identidade — `id`, `providerId`, `walletId`… — não lidos pelos testes); linhas soltas em `integration-event.ts:60` (ramo sem `causationId` no `toJSON`), `wallet-ledger-entry.ts:65` (ramo `rehydrate`), `hash.ts:33`. Demais arquivos de domínio: 100 %.

## IDs de teste exigidos × encontrados

Exigidos: U-01, U-02, U-03, U-04, U-05, U-06, U-07, U-08, U-09, U-13.
Encontrados (`grep -rhoE "TST-[UIC]-[0-9]+" test | sort -u`): TST-U-01 TST-U-02 TST-U-03 TST-U-04 TST-U-05 TST-U-06 TST-U-07 TST-U-08 TST-U-09 TST-U-13. **Nenhum ausente.**

## Provas de dentes (sem commitar)

| Mutação aplicada | Teste que falhou | Restaurado |
|---|---|---|
| Regex de `Money` aceita 2–3 casas | U-01 `rejects three decimals`, `errors are DomainErrors…` | sim |
| `Wallet.apply` sem a checagem de saldo negativo | U-03 `insufficient funds…`, `balance never goes negative…`, `InsufficientFundsError…` | sim |
| `Wallet.apply` debita somando | U-03/U-07 (`debit lowers the balance…`, `debit of the exact balance…` e outros) | sim |
| `isBalanced` soma no débito | U-07/U-03 (`debit lowers the balance…` e outros) | sim |
| `FAILED` deixa de ser terminal | U-04 (5 falhas) | sim |
| `reject` sem `assertOpen` (aceita a partir de terminal) | U-04 (5 falhas) | sim |
| `payloadHash` sem o campo `gameId` | U-06 (golden ×2 e `sensitive to gameId`) | sim |
| `scheduleRetry` sem o teto de 60 s | U-08 (`1s,2s,4s… capped`, `cap holds…`, `configurable`) | sim |
| `import "@nestjs/common"` em `wallet/domain/wallet.ts` | U-13 `shared and domain import neither…` | sim |
| `import type … "@mikro-orm/core"` em `src/shared/clock.ts` | U-13 (mesmo teste) | sim |
| `application/tmp.ts` com `import "../infrastructure/r"` | U-13 `application never imports infrastructure` | sim (arquivo removido) |
| Trocar a ordem player × moeda da wallet na política | U-05 `wallet player mismatch beats wallet currency mismatch` | sim |
| Trocar a ordem `kind` × `mismatch` na política | U-05 `kind not allowed beats mismatch…` | sim |

Incidente de processo: ao restaurar a mutação da T-010 usei `git checkout -- .`, que também desfez `package.json`/`bun.lock` (ainda não commitados). Refiz `bun add --exact big.js` e `bun add -d --exact @types/big.js` antes do commit; o diff final de dependências está correto. Depois disso as restaurações passaram a usar cópia de backup do arquivo.

## Desvios, decisões, dependências adicionadas

**Dependências:** `big.js@7.0.1` (runtime) e `@types/big.js@7.0.0` (dev), versões fixas; motivo: aritmética decimal exata do `Money` (ADR-0005). Sem outras.

**Interpretações/decisões de implementação (não alteram spec/ADR; revisar):**
1. `LedgerDirection` ficou em `wallet/domain/wallet-ledger-entry.ts` (T-011 precisa dele); a T-012 o reutiliza via import `wagering → wallet`. Não há dependência no sentido inverso.
2. `Wallet.debit/credit(money, transactionId, now, entryId)`: acrescentei `entryId` como 4º parâmetro (o id do lançamento precisa entrar por parâmetro). `Wallet.open` recebe também `now`.
3. Valor `<= 0` em `debit/credit` lança `InvalidMoneyError` (o ledger exige `amount > 0`; spec não define o caso zero).
4. `WalletLedgerEntry.create` valida, além da aritmética: moeda única, `amount > 0`, `walletVersion` inteiro ≥ 1 e saldos não negativos (espelham os CHECKs do banco). Instância congelada (`Object.freeze`).
5. `WagerTransaction`: `markProcessed(refId, at, observedBalance?)`, `reject(code, observedBalance?)`, `fail(code)`, `markPendingReference(nextAttemptAt)`, e `rescheduleReference(nextAttemptAt)` (incrementa `referenceAttempts`, não é transição). A primeira entrada em `PENDING_REFERENCE` não conta tentativa. Transições para terminal zeram `nextAttemptAt`. Não incluí `updatedAt` (não consta no README/design §2).
6. `ledgerDirectionFor` lança `LedgerDirectionUnavailableError` para `LOSS`, `ROLLBACK` sem referência e `ROLLBACK` de `LOSS/ROLLBACK/OPENING`.
7. **`REFERENCE_ALREADY_REVERSED` vale para qualquer kind que tenha referência** (inclusive `WIN`/`LOSS` apontando para uma `BET` já revertida), seguindo o texto do design §5 passo 2, que não restringe a reversões. **Peço confirmação do autor** desta leitura; o fato `alreadyReversed` é fornecido pelo caso de uso.
8. Política (T-015): referência com status `PENDING` lança `UnexpectedReferenceStateError` (estado inobservável, interpretação 7 do 01-requirements §12). `REVERSAL_WOULD_OVERDRAW` só se aplica a reversão cuja direção é `DEBIT` (ROLLBACK de WIN/REFUND); reversões a crédito nunca estouram saldo.
9. `OutboxMessage.enqueue(event, groupKey)` recebe o `groupKey` (walletId) explicitamente; `scheduleRetry(now, policy?)` aceita `{baseMs, capMs}` (padrão 1 s / 60 s) para as variáveis `OUTBOX_BACKOFF_*`; `markPublished/markFailed/scheduleRetry` em mensagem já finalizada lançam `InvalidOutboxStateError`. `InboxMessage.markProcessed` duas vezes lança `InvalidInboxStateError`.
10. Eventos usam interfaces estruturais (`WagerTransactionSnapshot`, `LedgerEntrySnapshot`) para o domínio de messaging não importar os de wagering/wallet. `playerId` não entra no `data` (permitido, não exigido). Campos opcionais são omitidos do JSON, nunca `null`.
11. `IdempotencyKey`: ASCII imprimível = 0x20–0x7E (espaço incluído).
12. T-016: `import type`, `export … from`, `import("x")` e `require("x")` literais **contam** como import; comentários são ignorados. O scanner (regex, `test/support/architecture.ts`) é provado por fixtures. A regra de `application → infrastructure` **varre 0 arquivos hoje** (pastas só com `.gitkeep`); não foi desligada: as fixtures provam que detecta violação e o teste confere que a contagem real = nº de `.ts` em `application/`. Passa a cobrir arquivos reais quando o primeiro chegar.
13. `Clock`/`SystemClock` e `IdGenerator`/`Uuidv7Generator` (`Bun.randomUUIDv7()`) em `src/shared`. `SystemClock` contém o único `new Date()` do código de domínio/shared (a implementação da porta).
14. Erros de wagering (`InvalidTransactionStateError` etc.) ficaram em `src/shared/errors.ts`; os de messaging em `messaging/domain/errors.ts`.

## Perguntas em aberto / bloqueios

- Item 7 acima (`REFERENCE_ALREADY_REVERSED` para `WIN`/`LOSS` referenciando `BET` já revertida) — confirmar.
- Item 3 (valor zero em `debit/credit`) e 2 (assinatura com `entryId`) — confirmar se aceitável.
- Sem bloqueios.

## Pré-condições da próxima onda verificadas

- Domínio puro entregue sem Docker; `typecheck`, `lint`, `test:unit` verdes e estáveis (3×).
- Falta mergear `wave/w2` na `main` (responsabilidade do autor) antes da W4. A afinação do Biome (T-004) chega no merge; o Biome baseline foi usado sem alterar regras.
- A `wave/w1` (outra sessão) não foi tocada; conflitos esperados somente em `package.json`/`bun.lock` (W1 pode adicionar dependências) e em `specs/06-tasks.md` (checkboxes de tarefas diferentes).
