# W9 — Consumidor SQS

**Slot:** quinta noite / sexta manhã · **Branch:** `wave/w9` (a partir da `main` com W7; idealmente também com W8) · **Depende de:** W7 · **Libera:** W10 · **Tamanho:** G · **CP3** depende desta onda.

## Prompt (cole na sessão)

```text
Você é a sessão executora da Onda W9 — Consumidor SQS do desafio Distributed Wagering Processor.
Trabalhe dentro do WSL, na pasta do repositório, branch wave/w9, criada a partir da main que contém a W7 (e a W8, se já mergeada).
Leia nesta ordem: CLAUDE.md, specs/README.md, specs/waves/_common.md e specs/waves/W9-consumidor-sqs.md. Depois leia somente a seção "Leitura" deste arquivo e specs/adr/0002-spike.md (semântica real do emulador SQS FIFO).
Execute APENAS T-041, T-042a, T-042b e T-044, nesta ordem, com testes primeiro, um commit por tarefa, protocolo de _common.md. Integração com PostgreSQL E SQS REAIS; nenhum mock desses dois.
Regras de ouro: ack (DeleteMessage) SÓ depois do commit; inbox ANTES do lock da wallet (ordem canônica de locks); o consumidor reutiliza o MESMO caso de uso e o MESMO schema Zod do HTTP. Não altere specs, ADRs nem decisões. Em dúvida, pare e pergunte (Problema/Opções/Recomendação/Explicação).
Ao final: rode o gate, escreva specs/waves/reports/W9-report.md e informe o veredito com a evidência.
```

## Leitura

[03-messaging.md](../03-messaging.md) §1–§3, §5, §8, §9 · [ADR-0015](../adr/0015-inbox-consumidor-e-resiliencia.md) · [ADR-0007](../adr/0007-ordem-de-locks-e-fluxo-transacional.md) · [ADR-0008](../adr/0008-idempotencia.md) · [ADR-0011](../adr/0011-estados-e-codigos-de-falha.md) · [02-design.md](../02-design.md) §5 (canal SQS, inbox) e §8 · [04-api.md](../04-api.md) §3, §4, §6, §7 · [01-requirements.md](../01-requirements.md) RF-MSG-*, RF-IDP-07, RF-API-04, RF-CON-06 · [05-test-plan.md](../05-test-plan.md) TST-U-11, TST-I-11, I-12, I-20, TST-C-01 · README do desafio §10 · `adr/0002-spike.md` · código das ondas anteriores (use case, schema Zod exportado, `FaultInjector`, `TransactionManager`, métricas).

## Pré-condições

`main` com W7 verde (schema Zod exportado, caso de uso HTTP completo, `TransientPersistenceError`/`InfrastructureUnavailableError`). `test:infra:up` ok; filas `wager-transactions.fifo` + DLQ + `wager-events.fifo` existem com `maxReceiveCount=8`.

## Tarefas

| Tarefa | Entrega | Testes que a fecham |
|---|---|---|
| **T-041** | Porta `MessageConsumer` + poller SQS (grupos em série, concorrência entre grupos, visibilidade, timeout, ack pós-commit, gancho de crash) | extras `X-POLLER-*` |
| **T-042a** | Ramo SQS do caso de uso (inbox antes do lock) + classificação de erros | **TST-U-11**, **TST-I-11**, **TST-C-01** (metade SQS) |
| **T-042b** | DLQ explícita para permanentes + exaustão (`FAILED`) | **TST-I-12** |
| **T-044** | Circuit breaker de infraestrutura | **TST-I-20** |

### T-041 — poller

- **Porta** `MessageConsumer` (application): registrar um `MessageHandler`, `start()`, `stop()`. **Adaptador** SQS fino sobre `@aws-sdk/client-sqs` ([ADR-0015](../adr/0015-inbox-consumidor-e-resiliencia.md)): `ReceiveMessage` com `MaxNumberOfMessages=10`, `WaitTimeSeconds=20` (configurável para testes), atributos `ApproximateReceiveCount` e `MessageGroupId`.
- **Agrupamento por `MessageGroupId`:** grupos diferentes em paralelo (até `SQS_CONCURRENCY`, 5); **mesmo grupo em série**, na ordem recebida; falha **transitória** devolve as seguintes do mesmo grupo no lote (`ChangeMessageVisibility = 0`) sem processar; falha **permanente** não bloqueia as seguintes.
- **Ack:** `DeleteMessage` **somente após** o handler concluir com sucesso (commit feito). **Gancho `crash-after-commit-before-ack`** do `FaultInjector` entre o fim do handler e o delete (N6).
- Timeout do handler `SQS_HANDLER_TIMEOUT_MS` (20 s, menor que a visibilidade de 30 s): estourou → não apaga, devolve.
- Flag `ENABLE_CONSUMER`; `start()/stop()`; `stop()` para de buscar e espera os handlers em voo (o shutdown completo é a T-053).
- **Testes `X-POLLER-*` (SQS real, handler gravador):** ordem dentro do grupo; **concorrência entre grupos** (observe sobreposição real de handlers de grupos distintos); mesmo grupo nunca sobrepõe; handler lento > timeout → mensagem **não** apagada e reaparece; sucesso → apagada; erro transitório devolve o resto do grupo; long polling funciona; `stop()` espera o em voo; simulação (em processo) do crash antes do delete → a mensagem volta.

### T-042a — inbox e classificação

- **Ramo SQS do `SubmitWagerTransaction`** (N2): `channel = SQS` com `messageId`. Na **mesma transação** e **antes do lock da wallet**: `INSERT inbox_messages (consumer_name = 'wager-transactions-consumer', message_id, payload_hash)` `ON CONFLICT DO NOTHING`. Já existia (e processado) → **ack sem processar**; `payload_hash` diferente para o mesmo `messageId` → **permanente** (DLQ na T-042b). Se a primeira transação do mesmo `messageId` ainda não commitou, o `INSERT` espera sem segurar lock de wallet (sem FK, [ADR-0007](../adr/0007-ordem-de-locks-e-fluxo-transacional.md)). Ao final da transação: inbox `processed_at`. `inbox.payload_hash` = SHA-256 do JSON canônico do **corpo inteiro** (helper da T-013). Sem o fast path por chave (é do canal HTTP).
- **Mensagem:** envelope `messageId`, `type = "WagerTransactionRequested"`, `occurredAt`, `data{…, idempotencyKey, referenceExternalTransactionId?}` validado pelo **mesmo schema Zod** do HTTP (importe o exportado na T-033; **não duplique**) mais o envelope. `correlationId` = `messageId` (contexto/ALS e eventos). `OPENING` → permanente (RF-TXN-02).
- **Classificação** (função pura `classifyError`, **TST-U-11** table-driven): *negócio* (resultado `PROCESSED`/`REJECTED`/`PENDING_REFERENCE`, replay, duplicata de inbox) → ack; *transitório da mensagem* (`TransientPersistenceError`: `55P03`, `40P01`, `57014`) → não apaga, `ChangeMessageVisibility = min(cap, base·2^(receiveCount−1))` (base 2 s, teto 30 s; `SQS_BACKOFF_*`), `retries_total{component=consumer}`, `lock_conflicts_total`; *infraestrutura* (`InfrastructureUnavailableError`, erros de rede do SQS) → sinal para o breaker (T-044) e mensagem volta com visibilidade 0; *permanente* (JSON inválido, schema inválido, `type` desconhecido, `kind = OPENING`, mesmo `messageId` com corpo diferente, **wallet inexistente** — P-7) → classificado como permanente. A saída para a DLQ é da T-042b; nesta tarefa o handler devolve o resultado tipado.
- **Testes:**
  - **U-11:** tabela de códigos Postgres, erros de aplicação, erros do SDK do SQS e erros de validação → classe esperada; `lock_timeout`/deadlock **não** são infraestrutura.
  - **I-11:** mesma mensagem (`messageId`) entregue 2× → **um** efeito (inbox); **HTTP e SQS compartilham a chave**: HTTP e depois SQS com mesma chave/payload → replay sem novo efeito (e o inverso); mesmo `messageId` com corpo diferente → classificado permanente e **sem efeito**; resultados de negócio (`REJECTED`, `PENDING_REFERENCE`) são ackados e a mensagem some da fila; transitório real (segure o lock da wallet numa conexão crua + `LOCK_TIMEOUT_MS` curto) → mensagem **não** apagada, visibilidade ajustada, depois processada (`eventually`) quando o lock é solto; ack só depois do commit (simule o crash antes do delete em processo → volta → inbox descarta → um efeito).
  - **C-01 (metade SQS, N4):** mesma `BET` 50× pelo SQS (variando `messageId` com a mesma chave, e também repetindo `messageId`), consumida por **duas instâncias de consumidor** em paralelo → **um** débito; invariante.

### T-042b — DLQ e exaustão

- **Permanente → DLQ imediata:** enviar à `wager-transactions-dlq.fifo` com os atributos `errorCode`/`reason`, **reaproveitando** `MessageGroupId` e `MessageDeduplicationId` da original (exigência da DLQ FIFO), depois `DeleteMessage`. `dlq_messages_total{reason}`++. A seguinte do mesmo grupo segue normalmente. Limitação documentada: enviar e depois apagar não é atômico (duplicata na DLQ é aceita).
- **Exaustão:** `ApproximateReceiveCount >= SQS_MAX_RECEIVE (8)` com falha persistente → **o consumidor** grava `FAILED` (`PROCESSING_ATTEMPTS_EXHAUSTED`) em transação própria **na ordem canônica** (lock da wallet → inserir/atualizar a transação), **só se** o payload for válido e o banco responder; emite `WagerTransactionFailed`; envia à DLQ; apaga. Se a transação já existir (sucesso em outra tentativa), apenas ack. O `redrivePolicy` do SQS é só rede de segurança para quedas do processo.
- **Testes I-12:** transitório com backoff de visibilidade crescente (use `SQS_BACKOFF_*` e `SQS_MAX_RECEIVE` pequenos por config, tendo em conta que a visibilidade do SQS é em **segundos inteiros**); permanente → DLQ imediata **e a mensagem seguinte do mesmo grupo é processada** (prove a ausência de bloqueio de cabeça de fila); exaustão (config reduzida, ex.: 3 recepções, lock mantido por uma conexão crua) → `FAILED` gravado + evento + mensagem na DLQ + removida da principal; wallet inexistente → DLQ imediata (P-7); `OPENING` → DLQ; falha transitória devolve o resto do grupo. Confirme que o **default** de `SQS_MAX_RECEIVE` na config é 8.

### T-044 — circuit breaker

- Erros de **infraestrutura** (conexão recusada, `57P01/57P03/08xxx`, pool esgotado, timeout de rede) **abrem o breaker**: o consumidor **para de buscar** (mensagem não recebida não consome tentativa), cooldown exponencial de `BREAKER_COOLDOWN_MIN_MS` (1 s) a `_MAX_MS` (30 s), e retoma quando um `SELECT 1` passar (estado meia-aberta). A mensagem em voo volta com visibilidade 0. `lock_timeout`/deadlock **não** abrem o breaker. Gauge `circuit_breaker_open`; exponha `isOpen()` para a readiness da T-052.
- **Teste I-20 sem derrubar o Postgres compartilhado:** construa em `test/support` um **proxy TCP** (`Bun.listen`) entre o app e o Postgres, que pode passar a recusar/derrubar conexões sob comando. O Postgres real continua de pé para as outras suítes. Cenário: 20 mensagens válidas; consumo em andamento; o proxy "derruba o banco" → breaker abre (`circuit_breaker_open = 1`), **a DLQ permanece vazia** (verifique por `GetQueueAttributes` depois de vários ciclos de cooldown, com `eventually` limitado e asserção negativa estável) e nenhuma mensagem esgota tentativas; o proxy volta → o breaker fecha e as 20 mensagens são processadas **exatamente uma vez**; `assertLedgerInvariant`.
- Testes unitários da máquina de estados (fechado → aberto → meia-aberta → fechado/aberto) com `Clock` injetável.

## Gate

| # | Verificação | Esperado |
|---|---|---|
| 1 | `bun install --frozen-lockfile` · `typecheck` · `lint` | limpos |
| 2 | `bun run test:infra:up` · `test:unit` · `test:integration` · `test:concurrency` (3×) | verdes, 0 skip |
| 3 | IDs exigidos | **TST-U-11, TST-I-11, TST-I-12, TST-I-20, TST-C-01 (metade SQS)** + `X-POLLER-*` |
| 4 | `grep -rn "DeleteMessage" src` | só no caminho pós-commit/pós-DLQ; revise cada ocorrência no relatório |
| 5 | Schema | `grep` confirma que o consumidor **importa** o schema Zod do HTTP (nada duplicado) |
| 6 | Manual | enviar uma `BET` pelo SQS (script) com a app local e ver o saldo mudar por `GET /wallets/:id`; cole as saídas |

**Provas de dentes (obrigatórias):**
1. Apague a mensagem **antes** do commit/handler concluir → o teste de crash antes do ack e/ou I-11 ficam vermelhos.
2. Remova o `INSERT` do inbox → I-11 vermelho (efeito duplicado).
3. Pule o `payload_hash` do inbox → "mesmo `messageId`, corpo diferente" vermelho.
4. Trate erro permanente como transitório (retentar) → I-12 vermelho (sem DLQ imediata / grupo bloqueado).
5. Desligue o breaker → I-20 vermelho (mensagens esgotam/vão à DLQ ou ficam duplicadas).
6. Faça `lock_timeout` abrir o breaker → o teste de classificação/I-12 fica vermelho.
7. Processe o mesmo grupo em paralelo → `X-POLLER-*` (sobreposição proibida) vermelho.

## Pare e pergunte se

O emulador FIFO divergir do que o spike registrou (bloqueio de cabeça de fila, redrive, visibilidade fracionada); o proxy TCP não for viável; a gravação do `FAILED` esbarrar na ordem de locks ou na unicidade da transação de forma não prevista; o schema Zod do HTTP precisar mudar para servir ao SQS; qualquer tarefa pedir mais de um commit.

## Fora do escopo

Processos reais e kill (W10), shutdown ordenado e readiness (W10), publisher e worker de pendentes (W8).

## Entregáveis

4 commits (T-041, T-042a, T-042b, T-044) + relatório · consumidor completo plugado na flag `ENABLE_CONSUMER`.
