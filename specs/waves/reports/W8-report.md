# Relatório W8 — Outbox e referências pendentes

- Data/hora: 2026-10-28 14:30 (-03) · branch `wave/w8` (a partir da `main` com a W7, `64ce353`) · HEAD das tarefas: `dc40e63`
- Veredito: **VERDE**

## Tarefas

| Tarefa | Commit | Testes que a fecham (ID → arquivo) | Vermelho → verde |
|---|---|---|---|
| T-040 Publisher da outbox | `479717f` | TST-I-13 → `test/integration/outbox-publisher.test.ts` (9 casos) e `test/integration/outbox-role.test.ts` (1, app real com `ENABLE_OUTBOX_PUBLISHER`); TST-C-06 (a) → `test/concurrency/outbox-publishers.test.ts` (3 publishers × 150 linhas); apoio unitário: `test/unit/messaging/sqs-batching.test.ts` (4), `test/unit/platform/polling-loop.test.ts` (4) | O código de produção foi esboçado **antes** dos testes. O vermelho foi obtido contra um stub vazio de `OutboxPublisher.publishOnce` (devolve zeros): 10 de 10 casos de integração falharam por comportamento (nada é publicado: `claimed/published` 0, evento ausente na fila, lag 0 em vez de 600). Depois, implementação restaurada: 10/10. O C-06 (a) passou na primeira execução (3 vezes seguidas, ~1 s); suas garantias estão nas provas de dentes |
| T-043 Worker de `PENDING_REFERENCE` | `dc40e63` | TST-I-10 → `test/integration/pending-worker.test.ts` (5 casos) e `test/integration/pending-worker-role.test.ts` (1, app real com `ENABLE_PENDING_WORKER`); TST-C-07 → `test/concurrency/pending-worker.test.ts` (4 casos) | Testes escritos antes da implementação, contra um stub de `PendingReferenceWorker.runOnce` que devolve zeros: I-10 5/5 vermelhos (`candidates` 0 em vez de 1, `rescheduled` 0 em vez de 1 etc.); C-07 3/3 vermelhos (o 4º caso foi acrescentado depois, ver provas de dentes). Depois da implementação: I-10 5/5, C-07 4/4 |

Os dois commits seguem Conventional Commits, sem `Co-Authored-By` e sem atribuição à ferramenta (conferido em `git log`).

## Gate (saída real)

| Comando | Exit | Resumo |
|---|---|---|
| `git status` | — | limpo |
| `bun install --frozen-lockfile` | 0 | 253 installs, sem mudanças |
| `bun run test:infra:up` | 0 | Postgres 5433 + SQS 4567 saudáveis; filas `unchanged` ×3 |
| `bun run typecheck` | 0 | limpo |
| `bun run lint` | 0 | 189 arquivos, sem erros nem warnings |
| `bun run test:unit` ×3 | 0 | 410 pass / 0 fail / 0 skip nas três (4,0 s · 4,3 s · 4,5 s) |
| `bun run test:integration` ×3 | 0 | 418 pass / 0 fail / 0 skip nas três (34,8 s · 35,0 s · 35,3 s) |
| `bun run test:concurrency` ×3 | 0 | 15 pass / 0 fail / 0 skip nas três (14,4 s · 14,0 s · 14,1 s) |
| `grep` de skips (`test`, `src`) | 1 | nada |
| `grep -rn "SKIP LOCKED" src` | — | só em arquivos do publisher (`outbox-repository.ts`, `mikro-outbox.repository.ts`, `outbox-publisher.ts`); **nenhuma** ocorrência no worker nem no repositório de `wager_transactions`. As ocorrências são comentários e o rótulo da transação: a cláusula SQL é gerada pelo MikroORM com `LockMode.PESSIMISTIC_PARTIAL_WRITE` (provado no spike) e o teste de linhas travadas é que garante o comportamento |
| Regressão (ondas anteriores) | 0 | os mesmos 402 + 8 unitários e 402 + 16 de integração anteriores seguem verdes dentro dos totais acima; o caso de uso da T-031/T-032 foi refatorado (ver desvios) e `submit-*.test.ts` passou sem alteração |

### Gate manual (item 5): app real com publisher ligado

Banco `manual_w8` na infra de teste (migrações aplicadas), `ENABLE_OUTBOX_PUBLISHER=true`, HTTP ligado, consumidor e worker desligados, SQS em `localhost:4567`:

```text
{"event":"app_started","roles":["http","outbox-publisher"],"port":3999}
POST /wallets            -> {"id":"01a1838f-f584-711e-b676-dac3067209f9",...,"balance":{"amount":"100.00","currency":"BRL"},"version":1}
POST /wagering/transactions (BET 25.00) -> {"transactionId":"01a1838f-f5d5-74ff-8aa1-372c0c799b60","status":"PROCESSED","balance":{"amount":"75.00","currency":"BRL"},...}
wager-events.fifo (3 mensagens, todas com MessageGroupId = walletId 01a1838f-f584-...):
  WalletBalanceChanged       eventId 01a1838f-f594-70a4-... (CREDIT 100.00, OPENING)
  WagerTransactionProcessed  eventId 01a1838f-f5dd-7242-... (BET)
  WalletBalanceChanged       eventId 01a1838f-f5dd-7243-... (DEBIT 25.00, balanceAfter 75.00)
outbox_messages: 3 linhas, attempts 0, published = t, failed = f
```

(Corpos completos dos eventos foram lidos da fila; omitidos aqui por tamanho.) Banco e processo removidos ao final.

## IDs de teste exigidos × encontrados

`grep -rhoE "TST-[UIC]-[0-9]+" test | sort -u` contém: **TST-I-10**, **TST-I-13**, **TST-C-06**, **TST-C-07**. Nenhum ausente. O C-06 cobre só a metade (a); a (b), kill real com `Bun.spawn`, é da W10 (fora do escopo).

## Provas de dentes

Cada mutação foi aplicada sem commitar, o teste rodou e a restauração foi confirmada por `diff` com cópia de segurança (e `git status`).

| Mutação aplicada | Teste que falhou | Restaurado |
|---|---|---|
| M1 (prova 1): `enqueue` grava fora da transação de negócio (`em.fork()` autocommit), de modo que o evento fica visível antes do commit do efeito. É o equivalente aplicável de "publicar antes do commit": o publisher é uma transação à parte, então a garantia é "só vê o que foi commitado" | `TST-I-13 publishes only after the commit of the effect` (o ciclo do publisher, rodado com a transação de negócio ainda aberta, passou a reivindicar a linha) | sim |
| M2 (prova 2): `PESSIMISTIC_PARTIAL_WRITE` → `PESSIMISTIC_WRITE` (sem `SKIP LOCKED`) | `TST-I-13 rows locked by another transaction are skipped without waiting…` (5,16 s: espera o `lock_timeout` de 5 s e falha) | sim |
| M3 (prova 3): falha transitória tratada como publicada (`published_at` sem confirmação) | `TST-I-13 a missing queue is transient…` e `TST-I-13 a SQS error that is not recognizably permanent never drops the event` | sim |
| M4 (prova 4): `eventId` do corpo aleatório a cada envio | 5 casos do I-13 (publica depois do commit, lote parcial, eventId estável, duplicata, fila inexistente) | sim |
| M4b: `MessageDeduplicationId` aleatório a cada envio | `TST-I-13 a duplicate publication is safe…` (o reenvio deixa de ser colapsado pela fila: 2 entregas em vez de 1) | sim |
| M5 (prova 5): sem revalidação depois dos locks no worker | `TST-C-07 … two active workers, repeated…` e `TST-C-07 two workers contending for the same candidates…` | sim |
| M5b: revalida o status, mas não o vencimento | **nenhum teste falhou** (lacuna). Acrescentei `TST-C-07 two workers on a still-missing reference count one attempt…`, que falhou com a mutação e passa sem ela | sim |
| M6 (prova 6): linha (`wager_transactions`) travada antes da wallet no worker | `TST-C-07 the worker takes the wallet lock before the row…` (deadlock `40P01` contra o lado "referência chegando", detectado de forma determinística) e o teste de dois workers ativos | sim |

## Desvios, decisões, dependências adicionadas

Nenhuma spec, ADR ou decisão foi alterada; a única edição em `specs/` são os dois checkboxes de `06-tasks.md`. Nenhuma dependência nova.

1. **Esboço do publisher antes dos testes (T-040).** Descrito na tabela de tarefas: o vermelho veio de um stub, não do código inexistente.
2. **Duplicata no FIFO.** `MessageDeduplicationId = eventId` faz o próprio SQS colapsar o reenvio dentro da janela de 5 min: depois de "publica, crasha, republica", o consumidor de teste vê **uma** entrega, não duas (o teste afirma isso e é o que a M4b derruba). Para provar também "duplicata é segura" no consumidor, o teste injeta o mesmo envelope com outro `MessageDeduplicationId` (equivale à janela expirada) e confere duas entregas e um item no inbox do teste.
3. **O emulador não aplica limites de tamanho.** LocalStack 4.14.0 aceitou 300 KB numa mensagem e 2 × 200 KB num lote. Consequências: (a) mensagem acima de 256 KiB é detectada por checagem do próprio adaptador (`MessageTooLong`, permanente), que é o que o teste exercita; (b) o lote é dividido de forma determinística para caber em 256 KiB (`chunkBySize`, coberto por teste unitário puro); (c) o fallback de isolamento, que reenvia uma a uma as entradas quando o SQS real recusa um lote inteiro com erro "inaceitável", **não é exercitado por nenhum teste** porque o emulador não gera esse erro. Fica documentado; o comportamento contra o SQS real não foi verificado.
4. **Classificação de erro do SQS por lista de permanentes.** Permanente apenas: `InvalidParameterValue*`, `InvalidMessageContents`, `InvalidAttributeValue*`, `BatchRequestTooLong`, `MessageTooLong`. Todo o resto (rede, timeout de 3 s, throttling, 5xx, `QueueDoesNotExist`, credenciais, erro desconhecido) é transitório, para nunca descartar um fato financeiro por engano. `QueueDoesNotExist` não é cacheada: a URL só é guardada depois de um lookup bem-sucedido.
5. **`outbox_lag_seconds`** = idade de `min(occurred_at)` entre as linhas pendentes (`published_at` e `failed_at` nulos), **inclusive as que estão em backoff**, medida depois do commit do ciclo. A spec diz "publicável"; interpretei como "ainda não publicada e não falha", porque uma linha em backoff continua atrasando o evento.
6. **Refatoração de T-032 sem mudar a assinatura pública.** `resolveReference`, `conclude` e `moveBalance` saíram de `SubmitWagerTransaction` para `TransactionConclusion` (`application/transaction-conclusion.ts`), usada pelo caso de uso e pelo worker. `SubmitWagerTransaction` mantém construtor e `execute`. Um `PENDING_REFERENCE` sobre uma transação que já está `PENDING_REFERENCE` é **retentativa** (conta a tentativa, reagenda, sem evento) e a que completa `PENDING_REF_MAX_ATTEMPTS` rejeita com `REFERENCE_NOT_FOUND`; a primeira entrada continua como antes. Resultado: o worker faz exatamente `PENDING_REF_MAX_ATTEMPTS` retentativas e os atrasos são os de ADR-0013 (5, 10, 20, 40, 80, 160 s com os defaults).
7. **`correlationId` dos eventos do worker.** Não há requisição nem `messageId`; cada tentativa gera um id novo (UUIDv7). Interpretação minha, sem texto na spec.
8. **Pequenas adições de código:** `PollingLoop` (`platform/infrastructure`, laço compartilhado pelos dois papéis; `stop()` termina o tick em curso), `eventId` em `LogFields` (uuid aleatório, não é dado de negócio), `WagerTransactionRepository.findDuePendingReferences` (leitura sem lock), três métodos em `OutboxRepository` (`lockPublishable`, `update`, `oldestPendingOccurredAt`) e `RecordingMetrics` do harness passou a registrar `retry`, lag e falhas de publicação. O tamanho do lote de candidatos do worker é a constante `DEFAULT_CANDIDATE_LIMIT = 50` (não há variável de ambiente para isso na spec).

## Perguntas em aberto / bloqueios

Nenhum bloqueio. Para o autor decidir, nada impede a W9/W10:

- **Métrica `wager_transactions_total` no worker.** O label `channel` só admite `http|sqs`, então o desfecho de uma pendente resolvida/rejeitada pelo worker **não** incrementa o contador (a entrada inicial como `PENDING_REFERENCE` foi contada na chegada). Contar exigiria um terceiro valor de `channel` (mudança no contrato de 04-api §7). Não alterei.
- **Cobertura do SQS real.** Os limites de tamanho e o fallback de lote recusado só podem ser verificados contra o SQS da AWS; no emulador, não.

## Pré-condições da próxima onda verificadas

- `test:infra:up` ok, filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo` existentes e `unchanged`.
- `OutboxPublisherRoleModule` e `PendingWorkerRoleModule` plugados nas flags `ENABLE_OUTBOX_PUBLISHER` e `ENABLE_PENDING_WORKER`; provado com o processo real (um teste por papel, mais o gate manual).
- `TEST_FAULT=crash-after-publish-before-commit` está ligado entre o `SendMessageBatch` e o commit; o kill real (C-06 b) fica para a W10. O shutdown ordenado completo (T-053) continua pendente: hoje `stop()` do publisher termina o lote em curso e o do worker não inicia novo candidato, ambos via `PollingLoop`.
- W9 (consumidor SQS) é independente desta onda; `SubmitWagerTransaction` já compartilha `TransactionConclusion` com o worker, o que a T-042a pode reaproveitar para o canal SQS.
