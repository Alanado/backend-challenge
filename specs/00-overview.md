# 00 — Visão geral

## 1. Objetivo

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de múltiplos provedores, por HTTP e por SQS, mantendo **correção financeira sob duplicação, desordem, concorrência, múltiplas instâncias e falhas**. Avaliação do enunciado: correção financeira (20), concorrência (20), idempotência (15), mensageria e falhas (15), modelagem (10), testes (10), observabilidade (5), documentação (5).

## 2. Escopo

**Dentro:** Money, Wallet, WagerTransaction, ledger imutável, idempotência persistente, lock por wallet, inbox/outbox transacionais, consumidor SQS com DLQ, worker de referências pendentes, reconciliação, health, métricas, logs estruturados, testes de integração e concorrência com Postgres e SQS reais.

**Fora (e documentado como evolução):** autenticação real (ponto de extensão apenas), reversão parcial, multi-moeda operacional (o modelo é multi-moeda; os testes usam BRL e provam o conflito de moeda), retenção/limpeza de inbox e outbox, ferramenta de reprocessamento de DLQ, ordem global de eventos, escala horizontal por fila single-writer.

**Backlog de stretch (se sobrar tempo, nesta ordem):** `test:load` → constraint trigger de consistência saldo×ledger → IdP real (Keycloak/Zitadel) → Swagger/OpenAPI → partidas dobradas → OpenTelemetry.

## 3. Invariantes globais (nunca podem ser violadas)

| # | Invariante | Onde é garantida |
|---|---|---|
| I-1 | Nenhum débito ou crédito duplicado | UNIQUE de idempotência + lock da wallet + inbox |
| I-2 | Saldo nunca negativo | `CHECK (balance >= 0)` + domínio + lock |
| I-3 | `wallet.balance` = saldo reconstruído pelo ledger | Uma entrada de ledger por mudança de saldo, na mesma transação; reconciliação |
| I-4 | Ledger é append-only | Triggers `BEFORE UPDATE/DELETE/TRUNCATE` |
| I-5 | Evento só é publicado depois do commit | Outbox transacional |
| I-6 | Nenhum evento confirmado é perdido | Outbox nunca desiste de erro transitório |
| I-7 | Uma transação referenciada é revertida no máximo uma vez | Índice único parcial (ADR-0010) |
| I-8 | Estados terminais de `WagerTransaction` não mudam | Domínio + trigger |
| I-9 | Correto com N instâncias | Toda garantia no banco; nenhum estado em memória |

## 4. Glossário rápido

- **Wallet:** conta de saldo de um jogador em uma moeda; unidade de concorrência.
- **Ledger:** extrato imutável; todo movimento de saldo gera exatamente uma entrada.
- **Idempotência:** repetir a mesma operação não muda o resultado (chave + hash do payload gravados no banco).
- **Outbox:** evento gravado na mesma transação do saldo; um publisher o envia depois.
- **Inbox:** `messageId` já visto, para descartar redelivery; ack só depois do commit.
- **`FOR UPDATE` / `SKIP LOCKED`:** lock pessimista de linha / pular linhas já travadas.
- **`PENDING_REFERENCE`:** a transação referenciada ainda não chegou; será reprocessada com backoff.
- **Replay:** reenvio idêntico; devolve o resultado original com `idempotentReplay: true`.

## 5. Premissas assumidas (por mim, não perguntadas — **veto do autor**)

| # | Premissa | Alternativa |
|---|---|---|
| P-1 | `playerId` e `roundId` **não** entram nos logs (identificadores de pessoa/jogo; o diagnóstico usa `transactionId`/`walletId`) | Incluí-los, documentando |
| P-2 | `causationId` do evento = id da transação que o causou (sem causação encadeada) | Encadear com o evento anterior |
| P-3 | Replay de `FAILED` responde **422** com `balance: null` (não aplicado e definitivo) | 200 com status `FAILED` |
| P-4 | Linhas terminais de `wager_transactions` são imutáveis também por trigger (além do domínio) | Só domínio |
| P-5 | `OPENING` usa `provider_id = 'system'`, `external_transaction_id = 'opening:<walletId>'`, mesma string como chave de idempotência | Tabela própria |
| P-6 | Cursor do ledger em ordem **decrescente** de `wallet_version`; `limit` padrão 50, máximo 200 | Ascendente |
| P-7 | Wallet inexistente no SQS vai para a DLQ (não há linha para gravar); no HTTP é 404 | — |
| P-8 | `Idempotency-Key`: 1 a 255 caracteres ASCII imprimíveis | Outro limite |
| P-9 | Reconciliação responde sempre 200; a divergência vai em `consistent: false` | 409 em divergência |
| P-10 | Erros HTTP em `application/problem+json` (RFC 9457) com `errorCode` e `correlationId` | Formato próprio |
| P-11 | `Retry-After: 1` nos 503 | Valor configurável por erro |
| P-12 | `playerId` e `walletId` são UUID (validação 400); `roundId`, `gameId`, `providerId` são strings (1..128) | — |
| P-13 | `amount` zero em transação é 400 (`CHECK (amount > 0)`) | Aceitar zero |
| P-14 | Timeouts: `lock_timeout` 5 s, `statement_timeout` 15 s, handler SQS 20 s, pool de 10 conexões por instância | Ajustar nos testes de carga |

## 6. Riscos e spike (Dia 1, antes de codar)

| ID | Risco | Verificação no spike | Plano B |
|---|---|---|---|
| R-01 | **LocalStack exige auth token desde 2026.03.0** (plano gratuito só para uso não comercial). O avaliador não pode depender de token | Subir a imagem **fixada em tag anterior a 2026.03** sem token; validar FIFO, `MessageGroupId`, deduplicação, DLQ FIFO, redrive | MiniStack (permitido pelo enunciado) — validar semântica FIFO, visibilidade e redrive antes de adotar; **token nunca no caminho padrão** |
| R-02 | Bun + NestJS + MikroORM (+ `@mikro-orm/nestjs`) | App sobe, DI com `emitDecoratorMetadata`, `em.transactional`, `LockMode`, migrator `up/down` | Fixar versão anterior do MikroORM; em último caso TypeORM (aceito pelo enunciado) |
| R-03 | AWS SDK v3 no Bun | `SendMessageBatch`, `ReceiveMessage` (long polling), `ChangeMessageVisibility`, FIFO + DLQ | Cliente HTTP assinado manualmente (evitar) |
| R-04 | `prom-client` no Bun | Counter, gauge, histogram e `GET /metrics` (não só métricas padrão) | Desligar métricas padrão; contadores próprios |
| R-05 | Biome (`noFloatingPromises`) e hook de commitlint sob Bun | Regras disponíveis; hook sem Husky global | Aceitar lacuna e documentar |
| R-06 | 8 GB de RAM (Postgres + SQS emulado + 3 instâncias + testes) | Medir uso no Compose completo | Reduzir pool/instâncias nos testes locais |

Resultado do spike vira um adendo ao ADR-0002 (`ADR-0002-spike.md`). Se R-01 ou R-02 falhar sem plano B viável, **parar e consultar o autor**.

## 7. Cronograma (3 dias)

| Dia | Milestones |
|---|---|
| 1 | M0 (spike + scaffold), M1 (domínio), M2 (persistência) |
| 2 | M3 (casos de uso + HTTP + concorrência básica), M4 (mensageria + multi-instância) |
| 3 | M5 (observabilidade + falhas), M6 (documentação + hardening); stretch se sobrar |

**Linha de corte:** se ao fim do Dia 2 M4 não estiver verde, cortam-se `test:load` e todo o stretch. M0–M5 são obrigatórios.
