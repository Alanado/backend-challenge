# Relatório W9 — Consumidor SQS

- Data/hora: 2026-10-28 · branch `wave/w9` (a partir da `main` com W7 e W8) · HEAD das tarefas: `da3b107`
- Veredito: **VERDE**, com duas ressalvas registradas abaixo (divergência de ordem do emulador; falha intermitente não identificada em duas rodadas do primeiro gate, não reproduzida em 6 execuções completas seguintes)

## Tarefas

| Tarefa | Commit | Testes que a fecham (ID → arquivo) | Vermelho → verde |
|---|---|---|---|
| T-041 | `440a8ad` | `X-POLLER-01..13` → `test/integration/sqs-poller.test.ts` (o `X-POLLER-14`, da DLQ, entrou na T-042b) | Contra um stub que não consome nada: 13 falhas por timeout (nada tratado). Com o poller: 12 verdes + 1 vermelho (ordem de reentrega, ver "Desvios" nº 1) → ajustado → 13/13, duas rodadas |
| T-042a | `ed7a911` | **TST-U-11** → `test/unit/wagering/classify-message-error.test.ts`, `wager-transaction-message.test.ts` · **TST-I-11** → `test/integration/sqs-consumer-inbox.test.ts` (+ `consumer-role.test.ts`) · **TST-C-01 (metade SQS)** → `test/concurrency/consumer-idempotency.test.ts` · `X-LOCK-ORDER` do canal SQS | U-11: com `classifyMessageError` stub, 44 de 50 vermelhos → 50/50. I-11: 5 de 8 verdes na primeira rodada (3 falhas eram do teste: ordenação por `created_at` e `receiveCount` com long poll fantasma); C-01 achou um **bug real** (replay sob outro `messageId` deixava o inbox sem `processed_at`), corrigido em `submit-wager-transaction.ts` e coberto no I-11 |
| T-042b | `b006579` | **TST-I-12** → `test/integration/sqs-consumer-dlq.test.ts` (+ `X-POLLER-14`, `consumer-role.test.ts`) | Implementação antes dos testes de I-12; o vermelho foi provado por mutação (prova de dentes nº 4: 8 falhas). 13/13 em duas rodadas seguidas |
| T-044 | `da3b107` | **TST-I-20** → `test/integration/consumer-breaker.test.ts` · máquina de estados `X-BREAKER` → `test/unit/messaging/circuit-breaker.test.ts` · proxy `X-PROXY` → `test/integration/tcp-proxy.test.ts` | Unitário: 8 vermelhos contra o stub → 9/9. I-20 escrito depois da implementação; vermelho provado por mutação (prova nº 5). Estável em 3 rodadas isoladas (≈ 7,5 s) |

Honestidade sobre a ordem "testes primeiro": T-041 e a máquina de estados do breaker foram vermelho→verde de verdade. Em T-042a o parser (`wager-transaction-message.ts`) foi escrito antes dos seus testes unitários (passaram de primeira); em T-042b e no I-20 a implementação veio antes dos testes de integração, e o vermelho foi demonstrado por mutação. Nenhum teste foi relaxado para passar.

## Gate (saída real)

| Comando | Exit | Resumo |
|---|---|---|
| `git status` · `bun install --frozen-lockfile` | 0 | limpo; "Checked 253 installs … (no changes)" |
| `bun run test:infra:up` | 0 | Postgres 5433 e LocalStack 4567 healthy; filas `unchanged` ×3 |
| `bun run typecheck` · `bun run lint` | 0 · 0 | sem erros; "Checked 213 files … No fixes applied" |
| `test:unit` (rodadas 1, 2, 3) | 0 ×3 | 486 pass / 0 fail / 0 skip (≈ 3,9 s) |
| `test:integration` (rodadas 1, 2, 3) | 0 ×3 | 460 pass / 0 fail / 0 skip (≈ 100 s) |
| `test:concurrency` (rodadas 1, 2, 3) | 0 ×3 | 16 pass / 0 fail / 0 skip (≈ 12,6 s) |
| `grep -rnE "\.(skip\|todo\|only)\b\|xit\(\|xdescribe\(" test src` | 1 (sem linhas) | nada encontrado |
| Manual (item 6) | — | ver abaixo |

**Primeiro gate (não conta):** nas 3 rodadas iniciais, `test:integration` terminou com 459 pass / **1 fail** nas rodadas 1 e 2 e 460/0 na 3; só capturei o `tail -5`, então **não sei qual teste falhou**. Nessa janela eu executei outros comandos em paralelo (greps e duas execuções parciais dos arquivos novos). Em seguida rodei `test:integration` completo 6 vezes sem nenhuma falha (3 numa rodada de caça + as 3 do gate final, todas com saída por arquivo), e 2 execuções parciais dos 4 arquivos de consumidor (38/38 cada). Suspeito de teste sensível a tempo sob carga de CPU (candidatos: `X-POLLER-04/06/10`, `TST-I-12` de backoff). Está em "Perguntas em aberto".

Verificação manual (item 6), com a aplicação real (`bun src/main.ts`, HTTP + consumidor), Postgres de teste (`w9_manual`, migrações aplicadas) e a fila `wager-transactions.fifo`:

```
$ bun manual-send.ts
wallet 01a183cd balance before: 100.00
sent BET 25.00 to wager-transactions.fifo
balance after: 75.00
transaction status: PROCESSED
$ grep app_started app.out
{"event":"app_started","roles":["http","consumer"],"port":3999}
… "messageId":"81617b0f-…","kind":"BET","status":"PROCESSED","channel":"sqs","durationMs":26,"msg":"wager transaction concluded"
```
(`correlationId` = `messageId` na linha de log; sem valores monetários, `playerId` nem `roundId`.) O saldo veio de `GET /wallets/:id`; o status, de `GET /providers/provider-a/wagering/transactions/:externalId`. O banco `w9_manual` foi apagado depois. Os scripts ficaram no scratchpad da sessão, fora do repositório.

## IDs de teste exigidos × encontrados

`grep -rhoE "TST-[UIC]-[0-9]+" test | sort -u` contém **TST-U-11**, **TST-I-11**, **TST-I-12**, **TST-I-20** e **TST-C-01** (esta, no arquivo `test/concurrency/consumer-idempotency.test.ts`, "SQS half"; a metade HTTP já existia). `X-POLLER-01..14` presentes. Nenhum ausente.

Revisão do item 4 do gate, `grep -rn "DeleteMessage" src`: uma única chamada real, `sqs-message-consumer.ts` método `acknowledge` (`new DeleteMessageCommand`), mais o import e um comentário. Ela só é alcançada por dois caminhos: (a) o handler devolveu `ack` (a transação do caso de uso já fez commit, e o gancho `crash-after-commit-before-ack` roda imediatamente antes); (b) o resultado foi `dead-letter` e `SqsDeadLetterQueue.send` já resolveu (se o envio à DLQ falha, o original fica e volta com visibilidade 0). `retry`, `release`, timeout e exceção do handler nunca apagam.

Item 5, o schema: `wager-transaction-message.ts:8` importa `submitWagerTransactionSchema` de `./submit-wager-transaction.schema` (o mesmo que o `wagering.controller.ts` usa no `ZodValidationPipe`); nada duplicado. Só o `idempotencyKey`, que no HTTP vem em header, é retirado de `data` antes. Há um teste que falha se esse import desaparecer.

## Provas de dentes

Todas feitas sem commitar, restauradas com cópia do arquivo original e confirmadas por `grep`/`git status`.

| # | Mutação aplicada | Teste que falhou | Restaurado |
|---|---|---|---|
| 1 | `acknowledge(delivery)` chamado **antes** de `invoke(handler)` no poller | `X-POLLER-04`, `05`, `06`, `07`, `08`, `09` (6 falhas) | sim |
| 2 | Bloco do inbox do ramo SQS desligado (`tryReceive` nunca executa) | todos os `TST-I-11` (8), o `X-LOCK-ORDER` SQS e o `TST-C-01` SQS | sim |
| 3 | Comparação de `payload_hash` do inbox desligada | `TST-I-11 the same messageId with another body is permanent…` (1 falha; 8 passam) | sim |
| 4 | `permanent` tratado como `retry` no handler | 8 falhas em `TST-I-12` (5 casos de DLQ imediata, mismatch, "não bloqueia o grupo", exaustão) | sim |
| 5 | Breaker desligado no módulo (`gate` e `infrastructure` removidos) | `TST-I-20` (o gauge `circuit_breaker_open` nunca chega a 1) | sim |
| 6 | `TransientPersistenceError` classificado como `infrastructure` | 4 falhas em `TST-U-11` (`55P03`, `40P01`, `57014`, "NOT infrastructure") e `TST-I-11 a transient lock failure…` | sim |
| 7 | Mesmo grupo em paralelo (agrupar por id da mensagem, não por grupo) | `X-POLLER-01` (ordem/sobreposição) e `X-POLLER-07` | sim |

Observação sobre a nº 5: a mutação derruba o teste já na fase do gauge, não na da DLQ. Com o breaker ligado, o que garante "DLQ vazia" é o `holdsFor(4 s)` do I-20 (DLQ, gauge, saldo parado e processo vivo, amostrados a cada 250 ms).

## Desvios, decisões, dependências adicionadas

1. **Divergência do emulador (ordem na reentrega).** O spike registrou o bloqueio de cabeça de fila para mensagens ainda **não recebidas**. Aqui, quando m1 falha com `retry` (invisível por 1 s) e m2/m3, do mesmo lote, são devolvidas com visibilidade 0, o LocalStack as entrega **antes** de m1 (ordem observada: m2, m3, m1). O comportamento é o literal da spec (visibilidade 0 para as seguintes). Ordem de grupo é otimização, e a correção vem do banco (03-messaging §1), então nada quebra; `X-POLLER-07` e `TST-I-12` afirmam só o garantido (as seguintes **não** são processadas no lote da falha e voltam com `receiveCount` 2). Ver pergunta A.
2. **Long poll abortado ainda consome.** Ao dar `stop()` com um `ReceiveMessage` em curso, o emulador pode entregar a próxima mensagem a essa conexão morta: ela some por uma visibilidade e volta com `receiveCount` + 1. Por isso os testes leem o `receiveCount` real em vez de assumir 1 e usam `handled.length`, não "receiveCount = 1". Sem impacto de correção (o inbox deduplica).
3. **`FAILED` com o lock da wallet mantido até o fim.** A spec sugere "exaustão com lock mantido por uma conexão crua → FAILED gravado". A gravação do `FAILED` precisa do mesmo `FOR UPDATE` da wallet (ordem canônica), então com o lock preso ela também estoura `lock_timeout` e **não** grava. Implementei: (a) exaustão com falha persistente que não prende o lock (`fail-mid-transaction`) → `FAILED` + evento `WagerTransactionFailed` + DLQ + removida; (b) lock preso até o fim → sem `FAILED` e sem evento, mas a mensagem sai para a DLQ (`PROCESSING_ATTEMPTS_EXHAUSTED`), conforme "sem banco não há FAILED… a DLQ é a fonte de verdade". Ambos testados. Ver pergunta B.
4. **Fiação da flag `ENABLE_CONSUMER` ficou na T-042b** (não na T-041): só então existe um handler para registrar; o `bootstrap.test.ts` (roles) seguiu verde. A T-041 entregou o poller e a porta.
5. **Classificação de erro desconhecido:** vira `transient` (backoff, limitado por `SQS_MAX_RECEIVE`, depois `FAILED`+DLQ), nunca descarte silencioso. Qualquer `DomainError` não mapeado é `permanent` (a mesma entrada falharia igual). Também são `permanent`: `IdempotencyKeyPayloadMismatch` e `ExternalTransactionIdConflict` (a spec não os lista; um 409 não tem como ser "resolvido" por retry).
6. **Timeout do handler e exceção do handler** → `release` (visibilidade 0, sem apagar). O handler da T-042a nunca lança; é a última linha de defesa do poller.
7. **Falhas de rede do SQS** (receive/delete/change visibility) **não** alimentam o breaker (que testa o banco com `SELECT 1`): o `receive` pausa 1 s e tenta de novo; delete/visibilidade falhos são registrados (a mensagem volta e o inbox descarta). A função `classifyMessageError` classifica esses erros como `infrastructure` (U-11), conforme a spec. O breaker só abre por falha de infraestrutura **do banco** vista pelo handler.
8. **Replay sob outro `messageId`** agora fecha o inbox (`processed_at`) também no caminho de duplicata de transação (bug achado pelo C-01 e corrigido na T-042a).
9. **Lote de até 10 mensagens do mesmo grupo é serial:** com 10 handlers de até 20 s, as últimas passam da visibilidade de 30 s e podem reaparecer enquanto ainda estão na fila interna. O inbox/lock tornam isso seguro (a segunda cópia espera e vira replay); não mexi no desenho.
10. **Config nova:** `SQS_WAIT_TIME_S` (0–20, padrão 20), para o `WaitTimeSeconds` configurável pedido na T-041 (com teste). `SQS_MAX_RECEIVE` tem padrão 8 (teste `TST-I-12 configuration`), e a fila de teste tem `maxReceiveCount=8`.
11. **ID de teste:** usei `X-BREAKER` e `X-PROXY` (extras). Meu primeiro rascunho usava `TST-U-12`, mas esse ID é da redação de logs; renomeado antes do commit.
12. **Código novo fora do pedido literal, mas necessário:** porta `InfrastructureProbe` + `MikroInfrastructureProbe` (`SELECT 1` e liberação de conexões mortas, reaproveitando `pg-pool-reaper`), `ReceiveGate` e `CircuitBreaker` (com `probeTimeoutMs`, 2 s), `RecordExhaustedTransaction`, `SqsDeadLetterQueue`, `submitWagerTransactionProvider` (um só provider do caso de uso para HTTP e consumidor).
13. **Dependências adicionadas:** nenhuma. Specs, ADRs e a ordem canônica de locks não foram alterados; só os checkboxes de T-041, T-042a, T-042b e T-044 em `06-tasks.md`.
14. `RecordingMetrics` (helper de teste) passou a registrar `dlq` e `breakerStates`; a assinatura de `SubmitWagerTransactionDeps` ganhou `inbox`.

## Perguntas em aberto / bloqueios

A. **Ordem de reentrega no emulador (desvio nº 1).** *Problema:* com `retry` em m1 e visibilidade 0 nas seguintes, o LocalStack as reentrega antes de m1; a spec do spike só cobria mensagens não recebidas. *Opções:* (1) manter a visibilidade 0 literal e aceitar a ordem frouxa (o que fiz); (2) dar às seguintes a mesma visibilidade de m1, preservando a ordem também no emulador; (3) não devolver as seguintes (deixá-las expirar a visibilidade de 30 s). *Recomendação:* manter (1): ordem é otimização, o banco garante o resto, e o SQS real tende a bloquear a cabeça de fila. *Explicação:* (2) e (3) mudam texto de spec/ADR ("`ChangeMessageVisibility = 0`"); precisam de decisão do autor antes do código.

B. **`FAILED` sem lock livre (desvio nº 3).** *Problema:* a spec descreve a exaustão com "lock mantido por uma conexão crua" gravando `FAILED`, mas a gravação precisa desse lock. *Opções:* (1) manter o que fiz (best-effort, DLQ como registro); (2) reservar uma tentativa que ignore o `lock_timeout` curto para o `FAILED`; (3) gravar o `FAILED` por outro caminho sem o lock da wallet (viola a ordem canônica/FK). *Recomendação:* (1). *Explicação:* (3) é proibido pela ordem de locks; (2) aumenta o tempo de espera sem garantia.

C. **Falha intermitente do primeiro gate (um teste de integração, nome não capturado, 2 de 3 rodadas).** Não reproduzida em 6 execuções completas e 2 parciais. Se reaparecer, a rodada do `test:integration` deve guardar a saída completa. Nada foi relaxado para esconder isso.

## Pré-condições da próxima onda verificadas

- W10 (multi-instância e ciclo de vida) precisa de: `ConsumerRole.stop()` que espera os handlers em voo (existe; o devolver-restantes-com-visibilidade-0 do shutdown ordenado é da T-053); `CircuitBreaker.isOpen()` para a readiness (existe, provido em `ConsumerRoleModule`; ainda não exposto à rota de readiness, que é da T-052); gancho `crash-after-commit-before-ack` nos dois sentidos (em processo, via `SimulatedCrashError`, testado; com SIGKILL real, não testado, é da W10).
- Infra de teste: `test:infra:up` ok; o proxy TCP (`test/support/tcp-proxy.ts`) serve também para testes de processo real.
