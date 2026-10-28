# W6 — Núcleo financeiro

**Slot:** quinta (primeira grande onda do dia) · **Branch:** `wave/w6` (a partir da `main` com W5) · **Depende de:** W5 · **Libera:** W7 · **Tamanho:** G · **É a onda que mais pesa na nota** (correção financeira, idempotência, base da concorrência).

## Prompt (cole na sessão)

```text
Você é a sessão executora da Onda W6 — Núcleo financeiro do desafio Distributed Wagering Processor.
Trabalhe dentro do WSL, na pasta do repositório, branch wave/w6, criada a partir da main que contém a W5.
Leia nesta ordem: CLAUDE.md, specs/README.md, specs/waves/_common.md e specs/waves/W6-nucleo-financeiro.md. Depois leia somente a seção "Leitura" deste arquivo.
Execute APENAS T-031a, T-031b e T-032, nesta ordem, com testes primeiro, um commit por tarefa, protocolo de _common.md. Integração com PostgreSQL REAL; nenhum mock do banco.
Esta é a lógica que mais pesa na avaliação. A ORDEM CANÔNICA DE LOCKS (inbox → lock da wallet FOR UPDATE → wager_transactions) é inegociável: nunca insira em wager_transactions antes de travar a wallet. Não altere specs, ADRs nem decisões. Em dúvida de regra, pare e pergunte (Problema/Opções/Recomendação/Explicação).
Ao final: rode o gate (inclusive as provas de dentes, que são obrigatórias nesta onda), escreva specs/waves/reports/W6-report.md e informe o veredito com a evidência.
```

## Leitura

[02-design.md](../02-design.md) §3, §5, §6, §7 · [ADR-0006](../adr/0006-concorrencia-lock-pessimista.md) · [ADR-0007](../adr/0007-ordem-de-locks-e-fluxo-transacional.md) · [ADR-0008](../adr/0008-idempotencia.md) · [ADR-0010](../adr/0010-reversao-unica-por-referencia.md) · [ADR-0011](../adr/0011-estados-e-codigos-de-falha.md) · [ADR-0013](../adr/0013-referencias-fora-de-ordem.md) · [ADR-0014](../adr/0014-outbox-e-eventos.md) · [03-messaging.md](../03-messaging.md) §4 (backoff) e §7 (eventos por cenário) · [04-api.md](../04-api.md) §2, §4, §6 · [01-requirements.md](../01-requirements.md) RF-TXN-*, RF-IDP-*, RF-WAL-04/05, RF-OUT-01/07, RF-REF-01/03 · [05-test-plan.md](../05-test-plan.md) TST-U-10, TST-I-05..I-09 · README do desafio §7 (regras) · o código das ondas anteriores (domínio, repositórios, `TransactionManager`, métricas, logger).

## Pré-condições

`main` com W5 verde (`typecheck`, `lint`, `test:unit`, `test:integration`). Existem: `WalletRepository.findByIdForUpdate`, `WagerTransactionRepository.insertIfAbsent`, `TransactionManager`, `FaultInjector`, `MetricsPort`, logger com ALS, `assertLedgerInvariant`.

## Escopo desta onda e fronteiras

- Testes **no nível do caso de uso** (chamando o caso de uso com Postgres real, em processo). O nível HTTP (status, problem+json, headers) dos mesmos cenários fecha na **T-033 (W7)** (fronteira N1).
- Só o canal **HTTP** do caso de uso. O ramo SQS/inbox entra na **T-042a** (N2). O parâmetro de canal já existe na assinatura.
- Sem controllers nesta onda.

## Tarefas

| Tarefa | Entrega | Testes que a fecham |
|---|---|---|
| **T-031a** | `SubmitWagerTransaction` — pipeline financeiro (`BET/WIN/LOSS`, `REJECTED`, ledger, outbox) | **TST-I-05**, **TST-I-06** (caso de uso) |
| **T-031b** | Idempotência (fast path, replay, conflitos) | **TST-I-07** (caso de uso) |
| **T-032** | Referências e reversões (`REFUND`, `ROLLBACK`, `PENDING_REFERENCE`) + backoff puro | **TST-I-08**, **TST-I-09**, **TST-U-10** |

### T-031a — pipeline financeiro

Fluxo exato do [02-design §5](../02-design.md), **sem** inbox e **sem** fast path:
1. Valida o comando já tipado, calcula o `payloadHash` (T-013) **antes** de qualquer acesso ao banco.
2. Abre a transação (`TransactionManager`, timeouts via `SET LOCAL`).
3. **`SELECT wallet FOR UPDATE`** (2º recurso). Inexistente → `WalletNotFoundError` e rollback (nada persistido; vira 404 na T-033).
4. `INSERT wager_transactions … ON CONFLICT DO NOTHING` **sem alvo de conflito** (3º recurso), status `PENDING`. Se **não inseriu**: a tratativa (replay/409) é da T-031b; nesta tarefa lance um erro interno explícito `DuplicateTransactionNotHandledYet` coberto por teste, para nunca processar duplicata por engano.
5. Regras na ordem do design: (1) player/moeda da wallet → `REJECTED` (`WALLET_PLAYER_MISMATCH`/`WALLET_CURRENCY_MISMATCH`), persistido; (3) aplicar. Se o comando traz `referenceExternalTransactionId`, lance um erro interno explícito `ReferenceResolutionNotImplementedYet` (será removido na T-032; coberto por teste) — **nunca ignore a referência**.
6. Aplicar: `BET` → `wallet.debit`; `InsufficientFundsError` → `REJECTED` `INSUFFICIENT_FUNDS` (sem ledger, `version` intacta); `WIN` → `credit`; `LOSS` → `PROCESSED` sem mover saldo e sem ledger.
7. Persistir: `UPDATE wallets … WHERE id AND version = $esperada` (0 linhas = bug, **sem retry**), `INSERT` do lançamento (com `wallet_version`), `UPDATE` da transação (`PROCESSED`/`REJECTED`, `observed_balance` = saldo sob o lock, `processed_at`), **outbox** na mesma transação com os eventos do [03-messaging §7](../03-messaging.md) (`PROCESSED` de `BET/WIN/REFUND/ROLLBACK`: `WagerTransactionProcessed` + `WalletBalanceChanged`; `LOSS`: só `Processed`; rejeição: só `WagerTransactionRejected`), com `eventId` = id da linha, `group_key` = walletId, `correlationId` do contexto, `causationId` = id da transação.
8. **Gancho `fail-mid-transaction`** (fronteira N6) **depois do ledger e antes do commit**, via `FaultInjector`.
9. Commit. Resultado: `{ transactionId, status, balance (= observed_balance), failureCode, idempotentReplay: false }`.
- Métricas e logs: `wager_transactions_total` (status/kind/canal/failure_code), `processing_duration_seconds`, `lock_conflicts_total` quando o `TransactionManager` traduzir `lock_timeout`/`deadlock`; `lock_conflicts_total{type=version_assert}` no `VersionAssertionError`. Logs com contexto, **sem valores**.

**Testes (use case + Postgres real):**
- **I-06 (caso de uso):** `BET` ok (saldo, 1 `DEBIT` com `wallet_version` correta, `PROCESSED`, `observed_balance`, 2 eventos com `data` exatos); `BET` sem saldo (`REJECTED`, `version` e saldo intactos, **zero** ledger, 1 evento `Rejected`); `WIN` credita; `LOSS` (`PROCESSED`, `version` intacta, zero ledger, 1 evento só `Processed`); player e moeda divergentes persistem `REJECTED`; wallet inexistente não persiste nada; `OPENING` submetido é rejeitado pelo domínio/validação.
- **I-05 atomicidade:** com `TEST_FAULT=fail-mid-transaction`, o erro sobe e **wallet, ledger, transação, inbox e outbox ficam todos como antes** (saldo e `version` iguais, contagens zero).
- **Ordem de locks** (extra `X-LOCK-ORDER`): capture os SQL emitidos e afirme que o `SELECT … FOR UPDATE` da wallet vem **antes** do `INSERT` em `wager_transactions`.
- Todo teste termina com `assertLedgerInvariant`.

### T-031b — idempotência

- **Fast path** (canal HTTP, sem lock): `SELECT` por `(provider_id, idempotency_key)`. Achou e `payload_hash` igual → **replay** (resultado do estado atual, `idempotentReplay: true`, saldo = `observed_balance` gravado, **sem** eventos, **sem** mudar `version`); hash diferente → `IdempotencyKeyPayloadMismatchError` (409). Não achou → segue para o pipeline.
- **Dentro da transação** (após o lock): se o `INSERT … ON CONFLICT DO NOTHING` não inseriu, **releia** por chave: mesmo hash → replay; hash diferente → mismatch; achou **só** pelo `external_transaction_id` (outra chave) → `ExternalTransactionIdConflictError` (409). Isso cobre a corrida de 50 chamadas idênticas que passam pelo fast path ao mesmo tempo.
- Replay segue o **estado atual** da transação (um `PENDING_REFERENCE` que virou `PROCESSED` responde `PROCESSED`); `FAILED` responde `balance: null`.
- Métrica `idempotent_requests_total{outcome=replay|conflict, channel}`.
- **Testes I-07 (caso de uso):** replay devolve o saldo **observado** (BET 25 → saldo 75; outra BET 10 → saldo 65; replay da primeira devolve 75.00, **não** 65.00); payload divergente → mismatch e **nada** alterado; mesmo `externalTransactionId` com outra chave → conflito; replay de `REJECTED` devolve o mesmo `failureCode`; replay não gera ledger nem evento; **persistência** (instancie um caso de uso/contêiner novo sobre o mesmo banco e o replay continua funcionando); smoke de paralelismo (10 chamadas idênticas por `Promise.all`: 1 original + 9 replays, 1 débito) — o teste oficial de 50× é o C-01 da W7.

### T-032 — referências e reversões

- Resolução da referência por `(providerId, referenceExternalTransactionId)` **sem filtro de wallet** (ADR-0013), **depois** do lock da wallet, seguindo a ordem do [02-design §5](../02-design.md), reutilizando as políticas da T-015.
- `PENDING_REFERENCE` quando a referência não existe: grava o estado com `next_attempt_at = now + atraso(tentativa 0)`, `reference_attempts = 0`, `observed_balance`, e emite **uma vez** `WagerTransactionPendingReference`; sem mudar saldo. Referência em `PENDING_REFERENCE` → esta também fica pendente (cadeia) e emite o evento na primeira entrada.
- Aplicação: `REFUND` credita; `ROLLBACK` usa `ledgerDirectionFor(reference)`; reversão que ficaria negativa → `REVERSAL_WOULD_OVERDRAW` (rejeitada, sem ledger); grave `reference_transaction_id`. **"Já revertida"** = existe reversão `PROCESSED` para a referência (`existsProcessedReversalOf`); o índice parcial é a rede de segurança.
- `WIN`/`LOSS` com referência opcional passam pela mesma validação (referência só pode ser `BET`). **Remova** o `ReferenceResolutionNotImplementedYet` da T-031a e atualize o teste dele.
- **Acordar dependentes:** quando uma transação vira `PROCESSED`, `UPDATE … SET next_attempt_at = now()` nos `PENDING_REFERENCE` que a referenciam, **restrito à wallet travada**, na mesma transação.
- **Backoff puro** (TST-U-10, fronteira N8): função `referenceBackoff(attempt, config, random)` — 6 tentativas, base 5 s, fator 2, jitter igual (`d/2 + rand(d/2)`), teto 300 s, configurável; com `random` injetável. A T-043 reutiliza.
- **Testes I-08 e I-09 (caso de uso, Postgres real):** `REFUND` restaura o saldo (`CREDIT`); `ROLLBACK` de `BET` (CREDIT), de `WIN` (DEBIT) e de `REFUND` (DEBIT); **cenário-chave: saldo 100,00 → `BET` 25 (75,00) → `REFUND` (100,00) → `ROLLBACK` da mesma `BET` = `REJECTED` `REFERENCE_ALREADY_REVERSED`, saldo permanece 100,00**; `REVERSAL_WOULD_OVERDRAW`; `REVERSAL_AMOUNT_MISMATCH`; `REFERENCE_KIND_NOT_ALLOWED` (`REFUND` de `WIN`, `ROLLBACK` de `LOSS`/`ROLLBACK`, `WIN` referenciando `WIN`); `REFERENCE_MISMATCH` (referência em **outra wallet** do mesmo provider, player/moeda/rodada divergentes); `REFERENCE_NOT_PROCESSED` (referência `REJECTED`); `WALLET_CURRENCY_MISMATCH` (RF-WAL-05); `PENDING_REFERENCE` (evento uma vez, saldo intacto); cadeia pendente; **acordar dependentes** (só da mesma wallet; os de outra wallet não são acordados); ordem determinística com vários desvios ao mesmo tempo.

## Gate

| # | Verificação | Esperado |
|---|---|---|
| 1 | `bun install --frozen-lockfile` · `typecheck` · `lint` | limpos |
| 2 | `bun run test:infra:up` · `test:unit` · `test:integration` (3×) | verdes, 0 skip |
| 3 | IDs exigidos | **TST-I-05, I-06, I-07, I-08, I-09, TST-U-10** + `X-LOCK-ORDER` |
| 4 | `assertLedgerInvariant` | presente ao final de todo teste que toca wallet |
| 5 | `grep -rn "NotImplementedYet" src` | nada (placeholders removidos) |
| 6 | `grep -rnE "number" src/modules/*/application` em pontos de dinheiro | nenhum dinheiro como `number` |

**Provas de dentes (obrigatórias, registre todas):**
1. Troque `SELECT … FOR UPDATE` por `SELECT` simples → o teste de **ordem de locks** e/ou os de concorrência da W7 precisam acusar (aqui, ao menos `X-LOCK-ORDER`).
2. Mova o `INSERT` em `wager_transactions` para **antes** do lock → `X-LOCK-ORDER` fica vermelho.
3. Remova o `ON CONFLICT` e a releitura → I-07 vermelho.
4. Compare o hash de forma frouxa (ignore um campo) → I-07 vermelho.
5. Pule o `INSERT` do outbox → I-06 vermelho; faça a falha injetada depois do commit → I-05 vermelho.
6. Remova a checagem de "já revertida" → o cenário `BET→REFUND→ROLLBACK` vermelho.
7. Remova o acordar dependentes → o teste de dependentes vermelho.
8. Inverta a direção do `ROLLBACK` de `WIN` → I-08 vermelho.

## Pare e pergunte se

O fluxo exigir mudar a ordem de locks; a releitura após conflito mostrar caso não previsto no design; a decisão de qual evento emitir num cenário não estiver no [03-messaging §7](../03-messaging.md); a política da T-015 divergir do §5 do design; T-031a, T-031b ou T-032 pedirem mais de um commit.

## Fora do escopo

Controllers, Zod de entrada HTTP, mapeamento de status (T-033); ramo SQS/inbox (T-042a); worker de pendentes (T-043); testes de concorrência oficiais (T-036).

## Entregáveis

3 commits + relatório · caso de uso completo para HTTP · backoff puro.
