# 01 — Requisitos

Cada requisito tem critério de aceite verificável e o teste que o prova (IDs em [05-test-plan.md](05-test-plan.md)). "§" refere-se ao README do desafio.

## 1. Money

| ID | Requisito | Critério de aceite | Origem | Testes |
|---|---|---|---|---|
| RF-MNY-01 | `Money` é imutável; entrada e saída são string decimal com escala 2 | `Money.from({amount:"25.00",currency:"BRL"}).toJSON()` devolve o mesmo par; toda operação devolve nova instância | §6.1, ADR-0005 | TST-U-01, TST-U-02 |
| RF-MNY-02 | Rejeita entradas inválidas | NaN, Infinity, notação científica, string vazia, mais de 2 casas, negativos em contratos de entrada e mais de 17 dígitos inteiros lançam erro de domínio (400 na API) | §6.1 | TST-U-01 |
| RF-MNY-03 | Aritmética exata e conflito de moeda | `add/subtract/negate/isLessThan/equals` exatos; moedas diferentes lançam `CurrencyMismatchError` | §6.1 | TST-U-02 |
| RF-MNY-04 | Nenhum `number` representa dinheiro | Serialização sempre `toFixed(2)`; `Money` só é construído de string validada; teste de serialização falha se houver conversão para `number` | §5.1 | TST-U-02 |
| RF-MNY-05 | Domínio independe de ORM e decorators NestJS | Teste de arquitetura: nenhum arquivo em `src/modules/*/domain` e `src/shared` importa `@mikro-orm/*` ou `@nestjs/*` | §6.1, ADR-0004 | TST-U-13 |

## 2. Wallet

| ID | Requisito | Critério de aceite | Origem | Testes |
|---|---|---|---|---|
| RF-WAL-01 | Uma wallet por (`playerId`, `currency`); `version` inicia em 1 | `POST /wallets` repetido → 409 `WALLET_ALREADY_EXISTS`; garantido por `UNIQUE (player_id, currency)` | §6.2, §9 | TST-I-19, TST-I-02 |
| RF-WAL-02 | Saldo inicial > 0 gera `OPENING` + lançamento `CREDIT` + evento `WalletBalanceChanged` na mesma transação SQL; saldo 0 não gera nada | Resposta com `version: 1`; ledger com 1 entrada `wallet_version = 1`; saldo zero → ledger vazio | §9 | TST-I-19 |
| RF-WAL-03 | Saldo nunca negativo | Domínio rejeita; `CHECK (balance >= 0)` impede mesmo via SQL direto | §5.7, §6.2 | TST-U-03, TST-I-02, TST-C-12 |
| RF-WAL-04 | `version` incrementa **somente** quando o saldo muda | `LOSS`, `REJECTED` e replays não alteram `version` | §6.2 | TST-U-03, TST-I-06 |
| RF-WAL-05 | Moeda da operação = moeda da wallet | Divergência → `REJECTED` `WALLET_CURRENCY_MISMATCH` | §6.2 | TST-I-09 |

## 3. Transações e regras de negócio

| ID | Requisito | Critério de aceite | Origem | Testes |
|---|---|---|---|---|
| RF-TXN-01 | Ciclo de vida: `PENDING → PROCESSED \| REJECTED \| PENDING_REFERENCE \| FAILED`; `PENDING_REFERENCE → PROCESSED \| REJECTED \| FAILED`; terminais imutáveis | Transição inválida lança `InvalidTransactionStateError`; `UPDATE` de linha terminal falha no banco | §6.3 | TST-U-04, TST-I-04 |
| RF-TXN-02 | `OPENING` não pode ser submetido por API nem fila | HTTP → 400; SQS → DLQ imediata | §6.3 | TST-I-06, TST-I-12 |
| RF-TXN-03 | `BET` debita; sem saldo → `REJECTED` `INSUFFICIENT_FUNDS`, sem ledger | Saldo e `version` inalterados | §7 | TST-U-05, TST-I-06 |
| RF-TXN-04 | `WIN` credita; referência opcional (se presente, deve ser `BET`) | Crédito + 1 entrada `CREDIT` | §7 | TST-U-05, TST-I-06 |
| RF-TXN-05 | `LOSS` não move saldo nem gera ledger | Status `PROCESSED`; evento só `WagerTransactionProcessed` | §7, §6.4 | TST-U-05, TST-I-06 |
| RF-TXN-06 | `REFUND` reverte uma `BET` `PROCESSED` (crédito do mesmo valor) | Saldo restaurado; 1 entrada `CREDIT` | §7 | TST-I-08 |
| RF-TXN-07 | `ROLLBACK` reverte `BET`, `WIN` ou `REFUND` `PROCESSED` com lançamento inverso | `BET`→CREDIT, `WIN`→DEBIT, `REFUND`→DEBIT | §7 | TST-I-08 |
| RF-TXN-08 | Valor da reversão é **igual** ao da referência | Diferente → `REJECTED` `REVERSAL_AMOUNT_MISMATCH` | §7.5 | TST-I-09 |
| RF-TXN-09 | Reversão que deixaria saldo negativo é rejeitada com código distinto | `REJECTED` `REVERSAL_WOULD_OVERDRAW`, auditável, sem ledger | §7.9 | TST-I-08 |
| RF-TXN-10 | `REJECTED` persiste a transação sem alterar saldo nem gerar ledger | Linha com `failure_code`; `version` inalterada | §6.4, §7.6 | TST-I-06 |
| RF-TXN-11 | Referência resolvida por (`providerId`, `referenceExternalTransactionId`) **sem filtro de wallet**; depois valida kind permitido, mesma wallet/player/moeda/rodada, status e se já foi revertida | Códigos: `REFERENCE_KIND_NOT_ALLOWED`, `REFERENCE_MISMATCH`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_ALREADY_REVERSED`; ordem de checagem em 02-design §5 | §7.2–7.4 | TST-I-09, TST-I-21 |
| RF-TXN-12 | Toda rejeição/falha carrega `failureCode` do catálogo estável | Valores somente do enum de 04-api §4 | §7.2 | TST-I-06, TST-U-11 |
| RF-TXN-13 | No máximo **uma** reversão `PROCESSED` por transação referenciada, de qualquer tipo | `BET → REFUND ✔ → ROLLBACK da mesma BET` = `REJECTED` `REFERENCE_ALREADY_REVERSED`, saldo permanece 100,00; índice único parcial no schema | §3, §7.4, ADR-0010 | TST-I-08, TST-I-21, TST-C-11 |

## 4. Ledger

| ID | Requisito | Critério de aceite | Origem | Testes |
|---|---|---|---|---|
| RF-LED-01 | Toda mudança de saldo tem exatamente uma entrada e vice-versa; no máximo uma por (wallet, transação) | `UNIQUE (wallet_id, transaction_id)`; teste compara `version` e número de entradas | §6.2, §6.4 | TST-I-05, TST-I-14 |
| RF-LED-02 | Ledger é append-only | `UPDATE`, `DELETE` e `TRUNCATE` falham mesmo para o dono da tabela | §5.5, §5.9 | TST-I-03 |
| RF-LED-03 | Lançamento balanceado | `CHECK` de aritmética; `WalletLedgerEntry.create` valida | §6.4 | TST-U-07, TST-I-02 |
| RF-LED-04 | Ordem total por wallet e paginação por cursor opaco e estável | `UNIQUE (wallet_id, wallet_version)`; cursor = `wallet_version` em base64url | §9 | TST-I-15 |

## 5. Idempotência

| ID | Requisito | Critério de aceite | Origem | Testes |
|---|---|---|---|---|
| RF-IDP-01 | Header `Idempotency-Key` obrigatório e fonte da verdade (padrão sugerido `{providerId}:{externalTransactionId}`) | Ausente/vazio → 400 `MISSING_IDEMPOTENCY_KEY` | §9 | TST-I-07 |
| RF-IDP-02 | Replay devolve o **resultado original** (incluindo o saldo observado) com `idempotentReplay: true` | Saldo do replay = `observed_balance` gravado, não o atual | §7.7, §9 | TST-I-07 |
| RF-IDP-03 | Mesma chave com payload diferente é conflito | 409 `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`; nada é alterado | §6.3, §9 | TST-U-06, TST-I-07 |
| RF-IDP-04 | Deduplicação persistente, nunca em memória | `UNIQUE (provider_id, idempotency_key)`; teste reinicia o serviço entre envios | §5.2 | TST-I-07, TST-C-08 |
| RF-IDP-05 | `payloadHash` = SHA-256 hex do JSON canônico dos campos de negócio | Algoritmo em 04-api §6; ordem das chaves não altera o hash | §9 | TST-U-06 |
| RF-IDP-06 | `externalTransactionId` é único por provedor | `UNIQUE (provider_id, external_transaction_id)`; outra chave com mesmo id → 409 `EXTERNAL_TRANSACTION_ID_CONFLICT` | ADR-0008 | TST-I-07, TST-C-09 |
| RF-IDP-07 | HTTP e SQS compartilham o espaço de chaves | Mesma chave por HTTP e depois por SQS → replay | §10 | TST-I-11 |

## 6. Concorrência

| ID | Requisito | Critério de aceite | Origem | Testes |
|---|---|---|---|---|
| RF-CON-01 | Duas `BET` de 80,00 simultâneas com saldo 100,00 | Exatamente uma `PROCESSED`, outra `REJECTED` `INSUFFICIENT_FUNDS`, saldo 20,00, **um** débito | §8 | TST-C-02 |
| RF-CON-02 | A mesma `BET` 50× em paralelo | Um único débito; 1 resposta original e 49 replays | §13 | TST-C-01 |
| RF-CON-03 | Wallets diferentes em paralelo, sem lock global | Throughput de N wallets não degenera para serial | §5.6 | TST-C-03 |
| RF-CON-04 | Correto com ≥ 3 instâncias simultâneas (HTTP + SQS) | Invariante final em todos os testes multi-processo | §5.8, §8 | TST-C-04 |
| RF-CON-05 | Sem deadlock: ordem canônica de locks (inbox → wallet → `wager_transactions`) | Carga mista sem `40P01` | ADR-0007 | TST-C-10 |
| RF-CON-06 | `lock_timeout` e deadlock são falhas **transitórias** | HTTP 503 + `Retry-After`; SQS retry com backoff; contam em `lock_conflicts_total` | ADR-0006 | TST-I-12, TST-C-10 |

## 7. Referências fora de ordem

| ID | Requisito | Critério de aceite | Origem | Testes |
|---|---|---|---|---|
| RF-REF-01 | Referência ausente → `PENDING_REFERENCE` + evento `WagerTransactionPendingReference` (uma vez) | HTTP 202; sem alteração de saldo | §7.8 | TST-I-10 |
| RF-REF-02 | Worker reprocessa com backoff exponencial (6 tentativas, base 5 s, fator 2, jitter, teto 5 min — configurável); esgotado → `REJECTED` `REFERENCE_NOT_FOUND` + `WagerTransactionRejected` | Tempos em ms nos testes | §7.1 | TST-I-10, TST-U-10 |
| RF-REF-03 | Quando uma transação é processada, dependentes **da mesma wallet** ficam vencidas na hora | `next_attempt_at = now()` na mesma transação | ADR-0013 | TST-I-10 |
| RF-REF-04 | Vários workers/instâncias não processam a mesma pendente duas vezes | Ordem wallet → linha, revalidação após o lock | ADR-0013 | TST-C-07 |
| RF-REF-05 | `ROLLBACK`/`REFUND` entregue antes da referência termina `PROCESSED` quando a referência chega | Saldo final correto, invariante do ledger | §13 | TST-C-07 |

## 8. Outbox

| ID | Requisito | Critério de aceite | Origem | Testes |
|---|---|---|---|---|
| RF-OUT-01 | Saldo, ledger, transação, inbox e outbox na mesma transação SQL | Falha injetada no meio → nada persiste | §11 | TST-I-05 |
| RF-OUT-02 | Evento nunca publicado antes do commit | Publisher só lê linhas commitadas | §5.4 | TST-I-13 |
| RF-OUT-03 | Vários publishers sem perder nem duplicar indefinidamente | `FOR UPDATE SKIP LOCKED`; dois publishers → cada evento publicado ao menos uma vez e o mesmo `eventId` | §11 | TST-I-13, TST-C-06 |
| RF-OUT-04 | Processo morre após o commit e antes de publicar; outra instância assume | Evento aparece na fila exatamente com o `eventId` original | §11 | TST-C-06 |
| RF-OUT-05 | `eventId` estável entre republicações; consumidor deduplica | Consumidor de teste com inbox por `eventId` ignora duplicata | §11 | TST-I-13 |
| RF-OUT-06 | Erro transitório: retry com backoff (teto 60 s) sem limite; erro permanente: `publish_failed` + alerta | Métricas `outbox_publish_failed_total` e `outbox_lag_seconds` | ADR-0014 | TST-I-13 |
| RF-OUT-07 | Eventos por cenário conforme 03-messaging §6 | `WalletBalanceChanged` somente quando o saldo muda | §11 | TST-I-06, TST-U-09 |

## 9. Consumidor SQS

| ID | Requisito | Critério de aceite | Origem | Testes |
|---|---|---|---|---|
| RF-MSG-01 | Reutiliza o **mesmo caso de uso** da entrada HTTP | Mesmo `SubmitWagerTransactionUseCase`, mesmo schema Zod | §10 | TST-I-11 |
| RF-MSG-02 | Deduplicação por inbox `(consumerName, messageId)` | Redelivery não duplica efeito | §10 | TST-I-11 |
| RF-MSG-03 | `ack` somente após o commit | Worker morto entre commit e ack → mensagem reentregue → descartada pelo inbox | §10 | TST-C-05 |
| RF-MSG-04 | Classificação: negócio (ack), transitório (backoff via visibilidade), permanente (DLQ imediata) | Tabela em 03-messaging §3 | §10 | TST-U-11, TST-I-12 |
| RF-MSG-05 | Esgotadas as tentativas (`ApproximateReceiveCount >= 8`): consumidor grava `FAILED`, envia à DLQ e apaga | `FAILED` auditável; DLQ contém a mensagem | §10, ADR-0015 | TST-I-12 |
| RF-MSG-06 | `SIGTERM`: conclui em andamento ou devolve a visibilidade | Nenhuma mensagem perdida; readiness falha | §10 | TST-I-18 |
| RF-MSG-07 | Circuit breaker: queda do banco não leva mensagens à DLQ | Banco derrubado durante o consumo → zero mensagens na DLQ; consumo retoma | ADR-0015 | TST-I-20 |
| RF-MSG-08 | Mesma wallet no mesmo lote: processamento em série; falha transitória devolve as seguintes do grupo; falha permanente não bloqueia as seguintes | Ordem preservada | ADR-0015 | TST-I-12 |

## 10. API, reconciliação, observabilidade, autenticação

| ID | Requisito | Critério de aceite | Origem | Testes |
|---|---|---|---|---|
| RF-API-01 | Endpoints: `POST /wallets`, `GET /wallets/:id`, `GET /wallets/:id/ledger`, `GET /wagering/transactions/:id`, `GET /providers/:p/wagering/transactions/:e`, `POST /wagering/transactions`, `POST /wallets/:id/reconciliation`, `GET /health/live`, `GET /health/ready`, `GET /metrics` | Contratos em 04-api | §9 | TST-I-06 |
| RF-API-02 | Status HTTP distingue payload inválido, conflito de idempotência, rejeição de negócio, aceite pendente e falha transitória, de forma consistente | Tabela em 04-api §2 | §9 | TST-I-06, TST-I-07 |
| RF-API-03 | Erros em `application/problem+json` com `errorCode` | Catálogo em 04-api §4 | §9 | TST-I-06 |
| RF-API-04 | Validação Zod única para HTTP e SQS | Mesmo schema exportado e usado pelos dois adaptadores | ADR-0020 | TST-I-11 |
| RF-REC-01 | Reconciliação lê saldo e ledger do mesmo snapshot (`REPEATABLE READ READ ONLY`, sem locks) | Resposta com `storedBalance`, `calculatedBalance`, `difference`, `consistent`, `checkedEntries` | §9, ADR-0016 | TST-I-14 |
| RF-REC-02 | Divergência é logada, contada em métrica e sinalizada; nunca corrigida em silêncio | `consistent: false`, `reconciliation_divergences_total`++ | §9 | TST-I-14 |
| RF-REC-03 | Verifica continuidade da cadeia (cada `balance_before` = `balance_after` anterior; versões sem buracos) | Divergência de cadeia sinalizada | ADR-0016 | TST-I-14 |
| RF-OBS-01 | Logs JSON com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` | Contexto por requisição/mensagem (AsyncLocalStorage) | §12 | TST-I-17 |
| RF-OBS-02 | Sem valores monetários, saldos, corpo de payload, `playerId` ou `roundId` nos logs | `redact` do pino + teste | §12, P-1 | TST-U-12 |
| RF-OBS-03 | Métricas mínimas do enunciado (04/03 listam os nomes) | `GET /metrics` expõe todas | §12 | TST-I-17 |
| RF-OBS-04 | `live` sem dependências; `ready` testa Postgres e SQS (timeout 2 s) e falha durante shutdown/breaker aberto/fila inexistente | — | §9, §12 | TST-I-16 |
| RF-AUT-01 | Autenticação não implementada: `AuthGuard` no-op + `ProviderIdentityPort`, desenho documentado | Health abertos; ponto de extensão no código | §2, ADR-0017 | revisão |

## 11. Não funcionais

| ID | Requisito | Critério |
|---|---|---|
| RNF-01 | TypeScript estrito (`strict`, `noUncheckedIndexedAccess`) | `bun run typecheck` limpo |
| RNF-02 | Migrations versionadas e reversíveis, `down` testado com ledger populado | TST-I-01 |
| RNF-03 | `docker compose up` sobe Postgres, SQS emulado e 3 instâncias | Documentado no README |
| RNF-04 | Cabe em 8 GB de RAM | Medido no spike (R-06) |
| RNF-05 | Conventional Commits; um commit por tarefa | commitlint |
| RNF-06 | `README.md` (setup e comandos) e `ARCHITECTURE.md` (decisões, trade-offs, limitações) | Entrega M6 |

## 12. Interpretações do enunciado adotadas (declaradas, §7 permite)

1. **Uma reversão por referência, de qualquer tipo** (a regra 4 literal permitiria `REFUND` + `ROLLBACK` da mesma `BET`, duplicando crédito). ADR-0010.
2. **`externalTransactionId` único por provedor**, necessário para resolver referências sem ambiguidade. ADR-0008.
3. **`WIN`/`LOSS` aceitam referência opcional a uma `BET`**; se informada, passa pelas mesmas validações e pode ficar `PENDING_REFERENCE`.
4. **`OPENING` emite apenas `WalletBalanceChanged`** (é interno, não é transação de provedor).
5. **Replay segue o estado atual da transação** (um `PENDING_REFERENCE` que virou `PROCESSED` responde 200 `PROCESSED`); o saldo exibido é o `observed_balance` gravado.
6. **`FAILED` é terminal, best-effort** (sem banco não há registro; a DLQ é a fonte de verdade); para tentar de novo o provedor envia nova transação (novo id externo e nova chave).
7. **`PENDING` nunca é observável por fora** (nasce e termina na mesma transação SQL).
8. **Rejeição de negócio persiste** a transação (auditoria), inclusive divergência de player/moeda da wallet; só wallet inexistente e payload inválido não são persistidos.
9. **Resolução da referência sem filtro de wallet**, para devolver `REFERENCE_MISMATCH` (terminal) em vez de esperar o backoff inteiro e terminar em `REFERENCE_NOT_FOUND`.
