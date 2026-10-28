# Guia de estudo — como entender e defender cada decisão

Objetivo: depois de ler isto você consegue explicar, sem consultar o código, **o que foi decidido, por quê, o que foi descartado e onde está a prova**. Leia na ordem; faça o exercício "explique em voz alta" de cada seção.

## 1. O sistema em 10 linhas

1. Provedores mandam operações de aposta (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) por HTTP ou SQS, **pelo menos uma vez**: podem repetir, chegar fora de ordem e em paralelo.
2. A **wallet** é a unidade de concorrência. Antes de decidir qualquer coisa que dependa do saldo, travamos a linha da wallet (`FOR UPDATE`).
3. Cada pedido tem uma **chave de idempotência** gravada no banco (`UNIQUE`). Repetir devolve o resultado original.
4. Cada mudança de saldo gera exatamente **uma linha no ledger**, que é imutável (triggers).
5. O efeito financeiro, o ledger, o inbox e o **outbox** acontecem na **mesma transação SQL**.
6. Um publisher lê o outbox (`SKIP LOCKED`) e publica no SQS **depois** do commit; pode duplicar, nunca perde.
7. Se a referência de um `REFUND`/`ROLLBACK` ainda não chegou, a transação fica `PENDING_REFERENCE` e um worker tenta de novo com backoff.
8. Erros são classificados: **negócio** (ack), **transitório** (retry com backoff), **permanente** (DLQ).
9. A **reconciliação** prova que `saldo = soma do ledger`; é a mesma função que valida todos os testes.
10. Tudo funciona com N instâncias porque nenhuma garantia vive em memória: está no banco.

## 2. Conceitos em uma frase

| Conceito | Frase |
|---|---|
| Idempotência | Repetir a operação não muda o resultado; chave + hash do conteúdo gravados no banco |
| Ledger | Extrato imutável; erro se corrige com lançamento inverso |
| `FOR UPDATE` | "Esta linha é minha até o commit"; quem chega depois espera |
| `FOR KEY SHARE` | Lock fraco que o Postgres toma na linha pai ao inserir um filho (FK); conflita com `FOR UPDATE` |
| `SKIP LOCKED` | Pula linhas já travadas por outro; permite vários workers sem disputa |
| `READ COMMITTED` | Cada comando enxerga o que já foi confirmado até aquele instante; leitura comum pode ficar velha |
| `ON CONFLICT DO NOTHING` | Insere ou, se violar uma unique, não faz nada (e espera quem está inserindo a mesma chave) |
| Outbox | Evento gravado junto com o saldo; um worker publica depois |
| Inbox | `messageId` já visto; descarta redelivery; ack só após commit |
| At-least-once | A mensagem chega uma ou mais vezes; o consumidor precisa ser idempotente |
| DLQ | Fila de mensagens mortas: o que não dá para processar vai para lá |
| FIFO + `MessageGroupId` | Ordem por grupo no broker; enquanto uma mensagem do grupo está em voo, as outras esperam (cabeça de fila) |
| Backoff exponencial | Tentar de novo esperando cada vez mais |
| Circuit breaker | Se a infraestrutura caiu, para de tentar por um tempo |

## 3. Decisões: o que defender

Formato: **decisão → por quê → o que foi descartado → pergunta provável → resposta curta → prova**.

### 3.1 Lock pessimista por wallet (ADR-0006)
- **Por quê:** em wallet quente a contenção *é* o problema; o lock serializa de forma previsível e mantém `Wallet.debit()` como dono da regra.
- **Descartado:** otimista (tempestade de retries em hot row); `UPDATE` atômico condicionado (move a regra para o SQL e o lock continua até o commit); fila single-writer (evolução).
- **Pergunta:** "Isso não vira gargalo?" **Resposta:** serializa só dentro da *mesma* wallet; wallets diferentes rodam em paralelo; a transação é curta e sem I/O externo; se o pool virasse gargalo, a evolução é fila por wallet.
- **Prova:** TST-C-02, C-03, C-12.

### 3.2 A ordem de locks e o deadlock que quase tivemos (ADR-0007)
- **A história:** nossa primeira ordem inseria a transação antes de travar a wallet. O `INSERT` toma `KEY SHARE` na wallet (FK) e isso conflita com `FOR UPDATE`; duas transações seguravam `KEY SHARE` e pediam `FOR UPDATE`: deadlock.
- **Regra:** inbox → wallet → `wager_transactions`; ordem total ⇒ sem ciclo.
- **Pergunta:** "Como você sabe que não há deadlock?" **Resposta:** ordem total de aquisição + teste de carga mista (TST-C-10) + se o Postgres detectar `40P01`, tratamos como transitório.
- **Pergunta:** "E o conflito de `external_transaction_id` entre wallets diferentes?" **Resposta:** a transação espera a outra terminar, mas a outra não precisa da nossa wallet, então não há ciclo (TST-C-09).

### 3.3 Idempotência no banco (ADR-0008)
- **Por quê:** colunas na própria `wager_transactions` com `UNIQUE (provider_id, idempotency_key)`; a mesma chave com hash diferente é conflito, não replay.
- **Duas camadas:** inbox (mesma mensagem) + chave (mesma operação em mensagens/canais distintos).
- **Pergunta:** "Por que guardar `observed_balance`?" **Resposta:** o enunciado exige que o replay mostre o saldo observado naquele momento; `LOSS` e `REJECTED` não têm linha de ledger de onde reconstruir.
- **Pergunta:** "Como 50 requisições iguais dão um débito?" **Resposta:** todas esperam o lock da wallet; a primeira insere; as outras batem na unique, releem e devolvem replay.
- **Prova:** TST-C-01, TST-I-07.

### 3.4 Ledger imutável por trigger (ADR-0009)
- **Por quê:** vale até para o dono da tabela; `REVOKE` não protege contra ele.
- **Cuidados:** `DROP TABLE` não dispara os triggers; um `down` que apaga linhas precisa desabilitá-los; `TRUNCATE` é bloqueado, por isso banco novo por suíte nos testes.
- **Ordem do ledger:** `wallet_version` único por wallet; cursor = versão. Ordem total porque a wallet é serializada.

### 3.5 Uma reversão por referência (ADR-0010) — a "interpretação"
- **O problema:** a regra 4 literal ("pelo mesmo tipo") permitiria `REFUND` e depois `ROLLBACK` da mesma `BET`: crédito duplo.
- **A conta:** 100 → 75 (BET) → 100 (REFUND) → sem proteção 125 (ROLLBACK). Com proteção, `ROLLBACK` é `REJECTED` e o saldo fica **100,00**.
- **Pergunta:** "Você alterou a regra?" **Resposta:** não a violei; apliquei a invariante global (não duplicar créditos), que é mais forte, e documentei como o §7 pede. Está no schema (índice único parcial).

### 3.6 `Money` com Decimal (ADR-0005)
- Escala fixa 2, parse estrito, rejeição acima de 2 casas e acima de 17 dígitos inteiros; nunca `number`; serialização `toFixed(2)`. Sem arredondamento porque nada com mais de 2 casas entra.
- **Pergunta:** "Por que não bigint?" **Resposta:** funcionaria; escolhi Decimal por aderência ao esqueleto do enunciado e documentei.

### 3.7 Domínio separado da persistência (ADR-0004)
- Construtor privado + fábricas; `rehydrate` não revalida; ORM com `EntitySchema` e mappers. Domínio sem `@mikro-orm`/`@nestjs` (teste de arquitetura).

### 3.8 Outbox com `SKIP LOCKED` (ADR-0014)
- Lê lote, publica, marca, commit. Morreu antes do commit ⇒ locks somem ⇒ outro republica com o **mesmo `eventId`**.
- **Pergunta:** "E se publicar duas vezes?" **Resposta:** at-least-once por desenho; o consumidor deduplica por `eventId`.
- **Limitações honestas:** sem ordem global entre publishers; consumidor ordena por `walletVersion`; erros permanentes viram `publish_failed`.

### 3.9 Consumidor, DLQ e resiliência (ADR-0015)
- Inbox antes do lock; ack só após commit; DLQ explícita para permanentes (porque no FIFO uma mensagem venenosa bloquearia a wallet inteira); exaustão grava `FAILED`; **circuit breaker** para queda do banco não encher a DLQ.
- **Pergunta:** "E se o worker morrer entre commit e ack?" **Resposta:** a mensagem volta; o inbox a descarta; um único efeito (TST-C-05).
- **Limitação:** DLQ + delete não é atômico; sem banco não há `FAILED` (a DLQ é a fonte de verdade).

### 3.10 `PENDING_REFERENCE` (ADR-0013)
- 6 tentativas, 5 s base, fator 2, ≈ 5 min; resolução sem filtro de wallet para dar `REFERENCE_MISMATCH` em vez de esperar tudo; dependentes são "acordados" na mesma transação; o worker segue a mesma ordem de locks.

### 3.11 Status HTTP (ADR-0012)
- 2xx aplicou · 202 pendente · 422 não aplicou (definitivo) · 400/409 corrigir · 503 reenviar. Erros em problem+json com `errorCode`; `failureCode` só para o que está **gravado**.

### 3.12 Reconciliação (ADR-0016)
- Snapshot único (`REPEATABLE READ READ ONLY`, sem lock) para não gerar divergência falsa; soma independente do saldo armazenado; checa a cadeia; nunca corrige.

### 3.13 Autenticação não implementada (ADR-0017)
- Não vale pontos; tempo e RAM foram para o que pontua; `AuthGuard` no-op + `ProviderIdentityPort` + desenho com OIDC/client credentials descrito.

### 3.14 Uso de IA e SDD (ADR-0001)
- "As decisões foram minhas, tomadas em rodadas com opções e justificativas; o Claude Code implementou tarefas pequenas, com testes primeiro. Cada requisito tem teste e rastreabilidade."
- **Prepare-se para:** "o que a IA errou?" — a primeira ordem de locks (deadlock por `KEY SHARE`) e a leitura literal da regra 4 foram corrigidas na revisão. Mostrar que **você** pegou/validou é o ponto.

## 4. Três cenários para saber de cor

### 4.1 Saldo 100, duas `BET` de 80 ao mesmo tempo
1. Cada uma entra numa transação e pede `FOR UPDATE` da wallet; uma ganha, a outra espera.
2. A vencedora lê saldo 100, debita 80, grava ledger (`wallet_version` 2), atualiza, comita. Saldo 20.
3. A outra obtém o lock, lê saldo 20, `BET` 80 ⇒ `INSUFFICIENT_FUNDS`, `REJECTED` (422), sem ledger.
4. Resultado: uma `PROCESSED`, uma `REJECTED`, saldo 20,00, um débito.

### 4.2 A mesma `BET` 50 vezes
1. 50 chegam; as que passam pelo fast path ainda não veem a linha.
2. Todas disputam o lock da wallet; a primeira insere a transação e processa.
3. As 49 seguintes, ao obter o lock, tentam inserir, batem na `UNIQUE`, releem, comparam o hash (igual) e devolvem replay (`200`, `idempotentReplay: true`).
4. Um débito, 49 replays.

### 4.3 Worker morre depois do commit e antes do ack
1. Mensagem processada e comitada (efeito + inbox + outbox).
2. O processo morre antes do `delete`.
3. A visibilidade expira; a mensagem volta; o inbox já tem o `messageId` ⇒ ack sem reprocessar.
4. Um único efeito; invariante do ledger intacta.

## 5. Limitações assumidas (diga você antes que perguntem)

- Sem ordem global de eventos entre publishers.
- DLQ + delete não atômico; sem banco não há `FAILED` (DLQ é a verdade).
- Sem retenção/limpeza de inbox e outbox.
- Sem ferramenta de reprocessamento de DLQ.
- Autenticação não implementada.
- Wallet quente tem vazão limitada pela duração da transação.
- Reversão parcial e multi-moeda operacional fora do escopo.
- Dependência do emulador SQS sem token (R-01): validar a semântica FIFO.

## 6. Frases de abertura (para a apresentação)

- "Li o desafio e entendi que o foco é consistência sob concorrência: idempotência persistida no banco, lock por carteira e outbox para não publicar antes do commit."
- "Cada garantia tem um mecanismo nomeado: lock, `UNIQUE`, `CHECK`, trigger. O código não é a única linha de defesa."
- "Documentei onde interpretei o enunciado e por quê: a regra de reversão única é o principal exemplo."

## 7. Checklist antes de apresentar

- [ ] Sei desenhar a ordem de locks e explicar o deadlock de `KEY SHARE`.
- [ ] Sei os três cenários da seção 4 passo a passo.
- [ ] Sei por que 422 e não 200 com `REJECTED`.
- [ ] Sei o que acontece com `FAILED` e por quê é best-effort.
- [ ] Sei as limitações da seção 5.
- [ ] Rodei a suíte inteira 3× e `docker compose up` do zero.
- [ ] Revisei o que mudou na implementação em relação às specs (T-062).

## 8. O que mudou na implementação em relação ao desenho (T-062)

Fonte: as seções "Desvios" dos [relatórios das ondas](waves/reports/). Nenhum ADR nem spec numerada foi alterado; onde o código difere do texto, a diferença está aqui e no [ARCHITECTURE.md](../ARCHITECTURE.md). Saiba dizer "o desenho dizia X, o código faz Y, e por quê".

| Tema | O desenho dizia | O código faz | Por quê / onde |
|---|---|---|---|
| Snapshot da reconciliação | [04-api §5](04-api.md): transação `REPEATABLE READ READ ONLY` | **Uma única instrução SQL** (snapshot único mesmo em `READ COMMITTED`, sem locks) | ADR-0016 admite as duas formas; reuso do reader da T-025b (W4, W7) |
| Shutdown | `enableShutdownHooks()` do Nest | Handler próprio de `SIGTERM`/`SIGINT` em `main.ts` | Sob Bun o hook do Nest reenvia o sinal e o processo sai com **143**, não 0 (W4) |
| Variável nova | — | `SHUTDOWN_DRAIN_DELAY_MS` (padrão 0; Compose 2000) | No `SIGTERM` o listener fechava na hora e o 503 da readiness ficava invisível; o autor aprovou (W10) |
| Pool de conexões | — | `pg-pool-reaper.ts`: libera clientes mortos presos no pool | Bug do MikroORM 7.2.5/Kysely (o `ROLLBACK` falha e o cliente não volta); decisão do autor, **remover quando o upstream corrigir** (W4) |
| `FAILED` com lock preso | Exaustão com o lock mantido grava `FAILED` | Sem lock livre não há `FAILED`: a mensagem vai à DLQ com `PROCESSING_ATTEMPTS_EXHAUSTED` | A gravação precisa do mesmo `FOR UPDATE` (ordem canônica); coerente com "sem banco, a DLQ é a verdade" (W9) |
| Falha de rede do SQS e o breaker | [03-messaging §3.2](03-messaging.md) lista "timeout de rede do SQS" como infraestrutura que aciona o breaker | `classifyMessageError` classifica assim (U-11), mas o breaker só abre por falha **do banco** vista pelo handler; falha de rede do SQS pausa o `receive` por 1 s | O breaker testa o banco com `SELECT 1` (W9 #7). **Divergência de texto: pergunta ao autor** |
| Ordem na reentrega | Seguintes do grupo voltam com visibilidade 0 e a ordem é preservada | No LocalStack elas voltam **antes** da mensagem que falhou | Ordem é otimização, o banco garante o resto (W9, pergunta A) |
| Erros "da mensagem" | Lista do 03-messaging §3.2 | Erro desconhecido é transitório (limitado por `SQS_MAX_RECEIVE`); `IdempotencyKeyPayloadMismatch` e `ExternalTransactionIdConflict` são permanentes | Nunca descartar em silêncio; um 409 não se resolve por retry (W9) |
| Backoff de referências | "6 tentativas" | O worker faz exatamente `PENDING_REF_MAX_ATTEMPTS` retentativas; a primeira entrada em `PENDING_REFERENCE` não conta tentativa | Atrasos 5, 10, 20, 40, 80, 160 s como no ADR-0013 (W2, W8) |
| `outbox_lag_seconds` | Idade do evento "publicável" mais antigo | Idade do mais antigo **não publicado e não falho**, inclusive os em backoff | Uma linha em backoff continua atrasando o evento (W8) |
| `wager_transactions_total` | Todo desfecho | **Não conta** o desfecho de pendência resolvida ou rejeitada pelo worker | O label `channel` só admite `http\|sqs`; contar mudaria o contrato do 04-api §7 (W8) |
| `REFERENCE_ALREADY_REVERSED` | Passo 2 do design §5 | Vale para **qualquer** comando com referência, inclusive `WIN`/`LOSS` que apontam para uma `BET` já revertida | O design não restringe a reversões; sem teste dedicado. **Aguarda confirmação do autor** (W2, W6, W7) |
| Assinaturas do domínio | `debit(money, …)` do enunciado | `Wallet.debit/credit(money, transactionId, now, entryId)`; `markProcessed(refId, at, observedBalance?)`; `markPendingReference(nextAttemptAt, observedBalance?)`; `OutboxMessage.enqueue(event, groupKey)` | Ids e relógio entram por parâmetro (domínio sem I/O) (W2, W6) |
| Config | Tabela do 02-design §8 | Acrescentou `NODE_ENV`, `PORT`, `LOG_LEVEL`, `DATABASE_URL`, `SQS_*` (endpoint, região, credenciais fictícias, nomes e URLs de fila), `SQS_WAIT_TIME_S` | Necessárias para subir; todas com padrão e validadas por Zod (W3, W9) |
| Logs | Campos do 04-api §8 | Tipo `LogFields` fechado, scrub profundo além do `redact`, limpeza das mensagens de erro do ORM; campos extras `eventId`, `reason`, `firstBreakAtVersion` | O pino aplica `formatters.log` antes dos serializers e o `redact` não é recursivo (W5, W7, W8) |
| Métricas padrão do Node | Não especificado | Desligadas; registro próprio por instância | Sob Bun só `process_*`/heap são confiáveis (spike, W5) |
| `GET` de transação | Envelope de resultado | Envelope mais `id`, `providerId`, `externalTransactionId`, `walletId`, `kind`, `money`, `referenceTransactionId`, `createdAt`, `processedAt`; `limit` do ledger fora de 1..200 é `400` | Defaults adotados na W7; **o autor pode vetar** |
| Ferramentas | `biome.json` (ADR-0020) | `biome.jsonc`, com `unsafeParameterDecoratorsEnabled` (sem isso o Biome não parseia `@Body`/`@Param`) | Nenhuma regra de lint foi desligada; os ADRs seguem citando `biome.json` (W1, W5) |
| `test:concurrency` | Falhar sem testes | Ainda usa `--pass-with-no-tests`, embora já existam 10 arquivos de concorrência | Sugestão da W1 (remover a flag) **não aplicada**: está fora do escopo da W11 |
| Eventos | `playerId` pode ir no `data` | `playerId` **não** vai no `data` dos eventos | Permitido, não exigido (W2) |

**Cortes:** nenhum do escopo obrigatório (T-044 foi feita). Ficaram de fora só as tarefas de stretch S-01..S-06; veja "Não implementado, documentado" em [traceability.md](traceability.md).

**Prepare-se para:** "o que mudou do desenho?" — responda pelas três linhas que mudam comportamento visível (reconciliação em uma instrução, shutdown próprio, `FAILED` sem lock) e diga que o resto são detalhes de assinatura e de configuração, todos nos relatórios.
