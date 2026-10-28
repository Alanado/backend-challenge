# ADR-0014 — Transactional Outbox, publishers e eventos

- **Status:** Aceita · **Data:** 2026-10-27 · **Relacionados:** RF-OUT-*, I-5, I-6

## Contexto
Os eventos devem ser atômicos com o efeito financeiro, publicados só depois do commit, sem perda, com vários publishers concorrentes, e seguros contra publicação duplicada.

## Opções consideradas (como disputar as linhas)
| Opção | Prós | Contras |
|---|---|---|
| **A. `SELECT … FOR UPDATE SKIP LOCKED` numa transação: lê lote, publica, marca, commit** | Pouco código; recuperação automática (conexão cai → locks somem); resposta canônica | Segura uma conexão durante a chamada ao SQS (timeout curto de 3 s) |
| B. Lease (`locked_until`) com transações curtas | Não segura conexão; tolera partição | Mais colunas e código; lease pode expirar com o publisher vivo |

## Decisão
**A**. Detalhes:
- `outbox_messages.id` = `eventId`, **estável** entre republicações; o consumidor deduplica por `eventId`.
- Lote de até 10 (`SendMessageBatch`). Por entrada: sucesso → `published_at`; falha transitória → backoff exponencial (base 1 s, teto 60 s), **sem desistir** (o evento é um fato financeiro confirmado); falha **permanente** (mensagem acima do limite, parâmetro inválido) → `failed_at` (`publish_failed`), métrica e alerta, sem retry infinito.
- Rede, throttling, 5xx e fila inexistente são transitórios; a readiness falha se a fila não existe e `outbox_lag_seconds` alerta.
- **Sem ordem global:** dois publishers podem enviar eventos da mesma wallet fora de ordem. O consumidor ordena por `walletVersion`/`occurredAt`. Limitação documentada.
- **Destino:** uma fila FIFO `wager-events.fifo` (`MessageGroupId = walletId`, `MessageDeduplicationId = eventId`). A dedup do SQS (janela de 5 min) é só otimização; a garantia vem do consumidor com inbox por `eventId`. Alternativa SNS FIFO + filas assinantes: mais infra, fora de escopo.
- **Consumidor de teste:** nenhum serviço consome os eventos no desafio; um consumidor de teste com inbox por `eventId` prova "publicação duplicada é segura".
- Eventos por cenário: ver 03-messaging §7 (`OPENING` emite só `WalletBalanceChanged`, interpretação documentada).
- Retenção das linhas publicadas: fora de escopo.

## Consequências
- (+) Sem perda; at-least-once explícito. (−) Duplicatas possíveis (por desenho); ordem não garantida entre publishers.
