# 05 — Plano de testes

Princípios: **PostgreSQL e SQS reais** nos testes de integração e concorrência (mock substituindo ambos é falha eliminatória); paralelismo real; sem `sleep` fixo; toda suíte termina checando a invariante final. ADR-0019.

## 1. Níveis e comandos

| Script | Conteúdo | Infra |
|---|---|---|
| `bun run test:unit` | `test/unit` — domínio, hash, backoff, classificação, redação de logs, arquitetura | nenhuma |
| `bun run test:integration` | `test/integration` — migrations, constraints, atomicidade, HTTP, SQS, outbox, health | Postgres + SQS emulado |
| `bun run test:concurrency` | `test/concurrency` — paralelismo real, ≥ 3 processos | idem |
| `bun run test` | as três, em sequência | idem |
| `bun run test:load` | (stretch) carga com metodologia e análise | Compose completo |
| `bun run test:infra:up` / `:down` | sobe/derruba o Compose de teste | Docker |

Cobertura reportada (`bun test --coverage`), **sem limite numérico**: o foco são os caminhos críticos e as falhas.

## 2. Infraestrutura de teste (ADR-0019)

- **Um** Postgres e **um** emulador SQS compartilhados (`docker-compose.test.yml`), subidos uma vez (cabe em 8 GB; Testcontainers por suíte seria pesado).
- **Banco novo por suíte:** um banco *template* migrado uma vez; cada suíte faz `CREATE DATABASE suite_x TEMPLATE tmpl`. O helper garante que **nenhuma conexão** esteja aberta no template. É a estratégia que contorna o `TRUNCATE` bloqueado pelos triggers do ledger. Dentro da suíte, cada teste usa ids únicos (UUIDv7) em vez de limpar tabelas.
- **Filas com sufixo aleatório** por suíte, criadas via SDK (incluindo DLQ com redrive).
- **Processos reais:** `Bun.spawn` sobe 3+ instâncias da aplicação apontando para o banco e as filas da suíte, com papéis por flag.
- **Seam de falha** (`TEST_FAULT`) para morte determinística; a aplicação **recusa** a variável quando `NODE_ENV=production`.
- **Determinismo:** helper `eventually(fn, {timeout})` com polling; `Clock` injetável nos unitários; tempos de backoff em milissegundos por configuração nos de integração.
- **`assertLedgerInvariant(walletId)`**: é **a mesma função** usada pela reconciliação; confere `balance = Σ ledger`, cadeia contínua, saldo ≥ 0, `version` coerente. Chamada ao fim de todo teste de integração e de concorrência.

## 3. Unitários

| ID | Cenário | Reqs |
|---|---|---|
| TST-U-01 | `Money`: parse/serialização, escala 2, entradas inválidas (NaN, Infinity, `1e3`, vazia, `1.234`, negativo, > 17 inteiros) | RF-MNY-01/02 |
| TST-U-02 | `Money`: aritmética, igualdade, imutabilidade, conflito de moeda, `toFixed(2)` e **nenhuma conversão para `number`** | RF-MNY-03/04 |
| TST-U-03 | `Wallet`: `debit`/`credit`, saldo insuficiente, `version` só sobe com mudança de saldo, moeda | RF-WAL-03/04 |
| TST-U-04 | `WagerTransaction`: transições válidas/inválidas, terminais, `rehydrate` sem revalidar | RF-TXN-01 |
| TST-U-05 | Regras por kind: `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK` (direção inversa) | RF-TXN-03..07 |
| TST-U-06 | `payloadHash`: invariante à ordem das chaves, sensível a qualquer campo de negócio, ignora metadados; payload divergente = conflito | RF-IDP-03/05 |
| TST-U-07 | `WalletLedgerEntry.create`: aritmética, `isBalanced` | RF-LED-03 |
| TST-U-08 | `OutboxMessage`/`InboxMessage`: `isDue`, `scheduleRetry`, `markPublished` | RF-OUT-06 |
| TST-U-09 | Envelope de evento: `toJSON`, dinheiro como string, `eventType`/`version` no tipo | RF-OUT-07 |
| TST-U-10 | Backoff de referências: sequência, teto, jitter limitado | RF-REF-02 |
| TST-U-11 | Classificação de erros (negócio/transitório/infra/permanente) por código Postgres e erro de SQS | RF-MSG-04 |
| TST-U-12 | Redação de logs: valores, saldos, payload, `playerId`, `roundId` nunca aparecem | RF-OBS-02 |
| TST-U-13 | Arquitetura: `domain` e `shared` sem `@mikro-orm/*` e `@nestjs/*`; `application` sem `infrastructure` | RF-MNY-05 |
| TST-U-14 | Ferramenta: `test:integration` e `test:concurrency` fixam timeout padrão de teste ≥ 20 000 ms (margem para máquinas lentas) | RNF-01 |
| TST-U-15 | Medição de carga: percentis nearest-rank (1 amostra, iguais, vazio → erro), taxa de erro (422 esperado não conta; 5xx, timeout, conexão e 4xx não planejado contam), soma por status | stretch S-01 |

## 4. Integração

| ID | Cenário | Reqs |
|---|---|---|
| TST-I-01 | Migrations `up` e `down` (inclusive com ledger populado); `down` desabilita triggers só onde apaga linhas | RNF-02 |
| TST-I-02 | Constraints: UNIQUE (wallet/player+moeda, idempotência, id externo, ledger), CHECK (saldo, valores, aritmética), FK | RF-WAL-01/03, RF-LED-03 |
| TST-I-03 | Ledger: `UPDATE`, `DELETE`, `TRUNCATE` falham (inclusive como dono da tabela) | RF-LED-02 |
| TST-I-04 | Transação terminal: `UPDATE`/`DELETE` falham; colunas de identidade imutáveis | RF-TXN-01 |
| TST-I-05 | Atomicidade: falha injetada após o ledger e antes do commit → wallet, ledger, transação, inbox e outbox **todos** ausentes | RF-OUT-01, RF-LED-01 |
| TST-I-06 | HTTP fim a fim para cada kind; mapeamento de status; formato problem+json; eventos emitidos por cenário; `OPENING` rejeitado | RF-API-*, RF-TXN-* |
| TST-I-07 | Idempotência HTTP: replay (saldo observado ≠ saldo atual), payload divergente (409), id externo com outra chave (409), chave ausente (400), persistência após reinício | RF-IDP-* |
| TST-I-08 | Reversões: `REFUND`; `ROLLBACK` de `WIN` e de `REFUND`; **`BET`(100→75) → `REFUND`(100) → `ROLLBACK` da mesma `BET` = `REJECTED` e saldo 100,00**; reversão que estouraria o saldo = `REVERSAL_WOULD_OVERDRAW` | RF-TXN-06..09/13 |
| TST-I-09 | Validação de referência: mismatch, kind não permitido, valor diferente, referência rejeitada/falha, já revertida; moeda/player da wallet | RF-TXN-11, RF-WAL-05 |
| TST-I-10 | `PENDING_REFERENCE`: chega antes da referência (202), é resolvida ao chegar (acordar dependentes), esgota e vira `REJECTED` `REFERENCE_NOT_FOUND` + evento; cadeia pendente | RF-REF-* |
| TST-I-11 | Inbox e redelivery; HTTP e SQS compartilham a chave; mesmo `messageId` com corpo diferente → DLQ | RF-MSG-01/02, RF-IDP-07 |
| TST-I-12 | Retry/DLQ: transitório com backoff de visibilidade; permanente → DLQ imediata (e a seguinte do grupo segue); exaustão (8 recepções) → `FAILED` + DLQ; falha transitória devolve o resto do grupo | RF-MSG-04/05/08 |
| TST-I-13 | Outbox: publica após commit; lote parcial; `eventId` estável; consumidor de teste deduplica por `eventId`; erro permanente → `publish_failed`; fila inexistente é transitória | RF-OUT-* |
| TST-I-14 | Reconciliação: consistente; divergência induzida (alterar `wallets.balance` direto) sinalizada e métrica incrementada; quebra de cadeia detectada; snapshot único | RF-REC-* |
| TST-I-15 | Paginação do ledger: cursor estável sob inserções concorrentes, limites, cursor inválido | RF-LED-04 |
| TST-I-16 | Health: `live` sem dependências; `ready` falha com banco fora, fila inexistente, breaker aberto e durante shutdown | RF-OBS-04 |
| TST-I-17 | `/metrics` expõe todas as métricas (counter, gauge, histogram); logs contêm os campos exigidos | RF-OBS-01/03 |
| TST-I-18 | `SIGTERM` com mensagens em voo: nenhuma perdida, readiness falha, handlers concluem ou devolvem | RF-MSG-06 |
| TST-I-19 | Criar wallet: saldo inicial gera `OPENING`+ledger+evento; saldo zero não gera; duplicada → 409; `version = 1` | RF-WAL-01/02 |
| TST-I-20 | Banco derrubado durante o consumo: breaker abre, **zero mensagens na DLQ**, consumo retoma e termina consistente | RF-MSG-07 |
| TST-I-21 | `WIN`/`LOSS` com referência a uma `BET` já revertida (`BET → REFUND`) → `REJECTED` `REFERENCE_ALREADY_REVERSED`, saldo/`version`/ledger intactos, rejeição persistida, replay idempotente; controle: `WIN` com referência a `BET` não revertida segue `PROCESSED` | RF-TXN-11, RF-TXN-13 |
| TST-I-22 | `bun run test:load -- --profile smoke` (3 instâncias reais, N1–N4) sai 0, imprime throughput, p50/p95/p99, taxa de erro, conflitos de lock e outbox lag, e a invariante do ledger vale em todas as wallets; sem assert de RPS | stretch S-01 |

## 5. Concorrência (paralelismo real)

| ID | Cenário | Reqs |
|---|---|---|
| TST-C-01 | A mesma `BET` 50× em paralelo (HTTP e SQS) → 1 débito, 1 original + 49 replays | RF-CON-02 |
| TST-C-02 | Saldo 100,00, duas `BET` de 80,00 → 1 `PROCESSED`, 1 `REJECTED`, saldo 20,00, 1 débito; repetir N vezes | RF-CON-01 |
| TST-C-03 | Wallets distintas em paralelo, sem bloqueio mútuo | RF-CON-03 |
| TST-C-04 | ≥ 3 instâncias (processos) processando HTTP + SQS ao mesmo tempo; invariante final | RF-CON-04 |
| TST-C-05 | Consumidor morto **depois do commit e antes do ack** (`crash-after-commit-before-ack`) → redelivery descartado pelo inbox, um único efeito | RF-MSG-03 |
| TST-C-06 | Dois publishers na mesma outbox; publisher morto após enviar e antes do commit → outra instância republica o mesmo `eventId` | RF-OUT-03/04 |
| TST-C-07 | `ROLLBACK`/`REFUND` entregue **antes** da referência, com a referência chegando em seguida e com dois workers ativos | RF-REF-04/05 |
| TST-C-08 | Reinício do serviço (kill + subir) com prova de consistência final e idempotência persistente | RF-IDP-04 |
| TST-C-09 | Mesmo `externalTransactionId` em wallets diferentes e chaves diferentes → um vence, o outro 409, **sem deadlock** | RF-IDP-06 |
| TST-C-10 | Carga mista (muitas wallets, duplicatas, reversões) → nenhum `40P01` | RF-CON-05 |
| TST-C-11 | `REFUND` e `ROLLBACK` da mesma `BET` em paralelo → exatamente uma `PROCESSED` | RF-TXN-13 |
| TST-C-12 | Wallet quente: 200 `BET` de 1,00 sobre 100,00 → exatamente 100 `PROCESSED`, saldo 0,00, nunca negativo | RF-WAL-03 |

## 6. Matriz do enunciado (§13 → testes)

| Exigência do §13 | Testes |
|---|---|
| Unidade: Money, Wallet, regras por kind, moeda, hash divergente | U-01..U-07 |
| Integração: migrations/constraints, atomicidade, inbox/redelivery, publishers concorrentes, retry/DLQ, recuperação | I-01..I-05, I-11..I-13, I-18..I-20, C-06 |
| Concorrência 1 (50× paralelo) | C-01 |
| Concorrência 2 (saldo disputado) | C-02 |
| Concorrência 3 (wallets distintas) | C-03 |
| Concorrência 4 (≥ 3 instâncias) | C-04 |
| Concorrência 5 (morto entre commit e ack) | C-05 |
| Concorrência 6 (dois publishers) | C-06 |
| Concorrência 7 (referência depois) | C-07, I-10 |
| Concorrência 8 (reinício) | C-08 |
| Invariante final em todos | `assertLedgerInvariant` |
