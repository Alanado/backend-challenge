# W8 — Outbox e referências pendentes

**Slot:** quinta à tarde/noite · **Branch:** `wave/w8` (a partir da `main` com W7) · **Depende de:** W7 · **Libera:** W10 (e é independente da W9) · **Tamanho:** M

## Prompt (cole na sessão)

```text
Você é a sessão executora da Onda W8 — Outbox e referências pendentes do desafio Distributed Wagering Processor.
Trabalhe dentro do WSL, na pasta do repositório, branch wave/w8, criada a partir da main que contém a W7.
Leia nesta ordem: CLAUDE.md, specs/README.md, specs/waves/_common.md e specs/waves/W8-outbox-e-referencias-pendentes.md. Depois leia somente a seção "Leitura" deste arquivo e specs/adr/0002-spike.md (semântica real do emulador SQS).
Execute APENAS T-040 e T-043, nesta ordem, com testes primeiro, um commit por tarefa, protocolo de _common.md. Integração e concorrência com PostgreSQL E SQS REAIS (emulador do Compose de teste); nenhum mock desses dois.
Evento só é publicado depois do commit; a ordem de locks (inbox → wallet FOR UPDATE → wager_transactions) vale também para o worker. Não altere specs, ADRs nem decisões. Em dúvida, pare e pergunte (Problema/Opções/Recomendação/Explicação).
Ao final: rode o gate, escreva specs/waves/reports/W8-report.md e informe o veredito com a evidência.
```

## Leitura

[03-messaging.md](../03-messaging.md) §4 (worker), §6 (outbox), §7 (eventos), §9 (seam) · [ADR-0013](../adr/0013-referencias-fora-de-ordem.md) · [ADR-0014](../adr/0014-outbox-e-eventos.md) · [ADR-0007](../adr/0007-ordem-de-locks-e-fluxo-transacional.md) · [02-design.md](../02-design.md) §4 (tabela `outbox_messages`), §5, §8 · [01-requirements.md](../01-requirements.md) RF-OUT-*, RF-REF-* · [05-test-plan.md](../05-test-plan.md) TST-I-10, TST-I-13, TST-C-06, TST-C-07 · `adr/0002-spike.md` · código da W7 (use case, repositórios, `FaultInjector`, `MetricsPort`).

## Pré-condições

`main` com W7 verde; `test:infra:up` ok; filas criadas (`wager-events.fifo` existe). `OutboxRepository.enqueue` e `wakeDependents` existem.

## Tarefas

| Tarefa | Entrega | Testes que a fecham |
|---|---|---|
| **T-040** | Publisher da outbox (`SKIP LOCKED`, lote, backoff, `publish_failed`, lag) + porta/adaptador `MessagePublisher` | **TST-I-13**, **TST-C-06 (a)** |
| **T-043** | Worker de `PENDING_REFERENCE` (wallet → linha, revalidação, acordar dependentes) | **TST-I-10**, **TST-C-07** |

### T-040 em detalhe

- **Porta** `MessagePublisher` (application) e adaptador `SqsMessagePublisher` (`SendMessageBatch`, **timeout de 3 s**): `MessageGroupId = group_key` (walletId), `MessageDeduplicationId = eventId`, corpo = envelope JSON do outbox. Resultado **por entrada** (sucesso, falha transitória, falha permanente).
- **Ciclo** (cada instância, a cada `OUTBOX_POLL_MS`, flag `ENABLE_OUTBOX_PUBLISHER`), numa transação ([03-messaging §6.2](../03-messaging.md)): `SELECT … WHERE published_at IS NULL AND failed_at IS NULL AND next_attempt_at <= now() ORDER BY occurred_at LIMIT $OUTBOX_BATCH FOR UPDATE SKIP LOCKED` → `SendMessageBatch` → por entrada: sucesso → `published_at`; falha **transitória** (rede, throttling, 5xx, **fila inexistente**, timeout) → `attempts+1` e `next_attempt_at` por backoff (base 1 s, teto 60 s, **sem limite de tentativas**, `OutboxMessage.scheduleRetry`), `retries_total{component=outbox}`; falha **permanente** (parâmetro inválido, mensagem acima do limite) → `failed_at`, `last_error`, `outbox_publish_failed_total`++ e log de erro; commit. Falha do lote inteiro = todas as entradas transitórias. **Nunca** publicar antes do commit do efeito (o publisher só enxerga linhas commitadas).
- `outbox_lag_seconds` (gauge) atualizado a cada ciclo: idade do evento publicável mais antigo (0 se não houver).
- **Gancho** `crash-after-publish-before-commit` do `FaultInjector` entre o `SendMessageBatch` e o commit (N6). Em testes em processo, o "crash" lança `SimulatedCrashError` (rollback da transação do publisher); o kill real com `Bun.spawn` é o C-06 (b), na W10.
- `stop()` que termina o lote em andamento (o shutdown completo é a T-053).
- **Consumidor de teste** (`test/support`): lê a fila de eventos e deduplica por `eventId` (inbox em memória **só do teste**, para provar "duplicata é segura" — a garantia do produto está no `eventId` estável).

**Testes (Postgres + SQS reais):**
- **I-13:** (1) publica **depois** do commit — numa transação aberta e **não commitada** insira um outbox; rode um ciclo do publisher → nada é enviado; commite → é enviado; (2) lote parcial com **falha real e parcial** (uma linha com `group_key` de 129 caracteres → permanente → `failed_at` + métrica; as demais do mesmo lote publicadas); (3) `eventId` na fila == `id` do outbox, estável em reenvios; (4) publicação duplicada (publique, force rollback via `SimulatedCrashError` depois do envio, publique de novo) → o consumidor de teste vê o mesmo `eventId` duas vezes e deduplica; (5) **fila inexistente é transitória**: aponte para uma fila que não existe → linhas ficam pendentes com `attempts` crescendo e backoff; crie a fila → são publicadas (`eventually`); (6) **linhas travadas por outra transação são puladas** (segure `FOR UPDATE` numa linha; o publisher publica as outras e não espera; ao soltar, publica a restante); (7) `outbox_lag_seconds` > 0 com evento antigo pendente e 0 depois de publicar; (8) mensagem acima do limite do SQS → permanente.
- **C-06 (a):** 2 (ou 3) publishers concorrentes sobre ≥ 100 linhas: todo `eventId` chega **ao menos uma vez**; o consumidor de teste (dedup) vê exatamente o conjunto esperado; nenhuma linha fica `failed_at`; todas `published_at`.
- Não use `sleep` fixo; `eventually` para o que é assíncrono.

### T-043 em detalhe

- **Worker** (flag `ENABLE_PENDING_WORKER`, a cada `PENDING_REF_POLL_MS`) conforme [03-messaging §4](../03-messaging.md) e [ADR-0013](../adr/0013-referencias-fora-de-ordem.md):
  1. Lê **sem lock** os candidatos `status='PENDING_REFERENCE' AND next_attempt_at <= now()` (limite).
  2. Para cada candidato, em transação própria e **na ordem canônica**: `FOR UPDATE` da **wallet** → relê a transação com `FOR UPDATE` e **revalida** (ainda `PENDING_REFERENCE` e vencida; senão descarta) → tenta resolver a referência **pelo mesmo código da T-032** (extraia/compartilhe a lógica "resolver e aplicar" entre os dois casos de uso, sem duplicar).
  3. Resultados: resolveu e aplicou → `PROCESSED` + `WagerTransactionProcessed` + `WalletBalanceChanged` e acorda dependentes; ainda ausente → `reference_attempts + 1`, `next_attempt_at = now + referenceBackoff(...)` (T-032), `retries_total{component=pending_reference}`, **sem** novo evento de pendência; divergência (mismatch, kind, referência rejeitada) → `REJECTED` com o código específico + `WagerTransactionRejected`; `reference_attempts >= PENDING_REF_MAX_ATTEMPTS` → `REJECTED` `REFERENCE_NOT_FOUND` + `WagerTransactionRejected`.
  4. Concorrência: até `PENDING_REF_CONCURRENCY` candidatos de **wallets distintas** em paralelo; mesma wallet em série. **Não** use `SKIP LOCKED` na linha primeiro (inverteria a ordem de locks; ADR-0013).
- `stop()` conclui a transação em curso.
- **Testes (Postgres real; tempos de backoff em milissegundos por config):**
  - **I-10:** `REFUND` chega antes da `BET` → 202 `PENDING_REFERENCE` (evento uma vez); a `BET` é processada → dependente **acordado** (`next_attempt_at ≈ now`) → worker processa o `REFUND` → `PROCESSED`, saldo certo, eventos certos, `assertLedgerInvariant`; **esgotamento** (referência nunca chega) → `REJECTED` `REFERENCE_NOT_FOUND` + `Rejected` após exatamente `PENDING_REF_MAX_ATTEMPTS`, saldo intacto; **cadeia** (`ROLLBACK` → `REFUND` pendente → `BET` chega) resolve em ordem; mismatch descoberto na retentativa → `REJECTED` `REFERENCE_MISMATCH`; dependente de **outra wallet** não é acordado e espera o backoff.
  - **C-07:** `REFUND`/`ROLLBACK` entregue **antes** da referência, a referência chega em seguida, com **dois workers ativos** (duas instâncias do worker sobre o mesmo banco, em processo) e repetido várias vezes: cada pendente é processada **exatamente uma vez** (um lançamento por transação), saldo final correto, invariante do ledger. Prove a revalidação: duas instâncias disputando o mesmo candidato → um efeito.
  - **Config (`PENDING_REF_*`):** os defaults (6 tentativas, base 5 s, fator 2, teto 300 s) estão na config; os testes só sobrescrevem para milissegundos.

## Gate

| # | Verificação | Esperado |
|---|---|---|
| 1 | `bun install --frozen-lockfile` · `typecheck` · `lint` | limpos |
| 2 | `bun run test:infra:up` · `test:unit` · `test:integration` · `test:concurrency` (3×) | verdes, 0 skip |
| 3 | IDs exigidos | **TST-I-10, TST-I-13, TST-C-06 (a), TST-C-07** |
| 4 | `grep -rn "SKIP LOCKED" src` | presente no publisher; **ausente** no worker de pendentes |
| 5 | Manual | rode app com publisher ligado, crie wallet+BET por `curl` e leia o evento na fila de eventos (cole a saída) |
| 6 | Regressão | todos os testes de ondas anteriores seguem verdes |

**Provas de dentes (obrigatórias):**
1. Mova o `SendMessageBatch` para **antes** do commit do efeito financeiro (ou publique de dentro da transação de negócio) → o teste "publica depois do commit" fica vermelho.
2. Remova o `SKIP LOCKED` → o teste de linhas travadas fica vermelho (o publisher espera/bloqueia).
3. Marque `published_at` antes de confirmar o envio → o teste de falha transitória deixa evento perdido e fica vermelho.
4. Torne `eventId` aleatório a cada envio → I-13 (eventId estável) vermelho.
5. Remova a revalidação após o lock no worker → C-07 vermelho (efeito duplicado/erro de `UNIQUE`).
6. Inverta a ordem (linha antes da wallet) no worker → o teste de ordem de locks/C-07 acusa (ou documente, se não acusar, e fortaleça o teste).

## Pare e pergunte se

O emulador tratar falha parcial de lote de forma diferente da registrada no spike; a classificação de algum erro do SQS for ambígua; a lógica compartilhada entre T-032 e T-043 pedir mudar assinatura pública da T-032 de forma relevante; qualquer tarefa pedir mais de um commit.

## Fora do escopo

Consumidor SQS (W9), kill real de processo (W10), shutdown ordenado (T-053), health.

## Entregáveis

2 commits + relatório · publisher + worker funcionando e plugados nas flags de papel.
