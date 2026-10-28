# W10 — Multi-instância e ciclo de vida

**Slot:** sexta (manhã/meio do dia) · **Branch:** `wave/w10` (a partir da `main` com **W8 e W9**) · **Depende de:** W8 + W9 · **Libera:** W11 · **Tamanho:** G · **CP4 (congelamento de código)** fecha aqui.

## Prompt (cole na sessão)

```text
Você é a sessão executora da Onda W10 — Multi-instância e ciclo de vida do desafio Distributed Wagering Processor.
Trabalhe dentro do WSL, na pasta do repositório, branch wave/w10, criada a partir da main que contém W8 e W9.
Leia nesta ordem: CLAUDE.md, specs/README.md, specs/waves/_common.md e specs/waves/W10-multi-instancia-e-ciclo-de-vida.md. Depois leia somente a seção "Leitura" deste arquivo e specs/adr/0002-spike.md.
Execute APENAS as tarefas NESTA ORDEM: T-052, T-046, T-053, T-005b. Testes primeiro, um commit por tarefa, protocolo de _common.md. Processos REAIS (Bun.spawn), PostgreSQL e SQS REAIS; nenhum mock.
Esta onda prova o requisito eliminatório "correto com múltiplas instâncias". As provas de dentes são obrigatórias. Não altere specs, ADRs nem decisões. Em dúvida, pare e pergunte (Problema/Opções/Recomendação/Explicação).
Ao final: rode o gate (suíte completa, mais docker compose do zero), escreva specs/waves/reports/W10-report.md e informe o veredito com a evidência.
```

## Leitura

[03-messaging.md](../03-messaging.md) §5, §6, §8, §9 · [ADR-0015](../adr/0015-inbox-consumidor-e-resiliencia.md) · [ADR-0014](../adr/0014-outbox-e-eventos.md) · [ADR-0018](../adr/0018-observabilidade.md) (health) · [ADR-0019](../adr/0019-estrategia-de-testes.md) · [02-design.md](../02-design.md) §8–§9 · [04-api.md](../04-api.md) §1 e §7 · [01-requirements.md](../01-requirements.md) RF-CON-04/05/06, RF-MSG-03/06/07, RF-OUT-03/04, RF-IDP-04, RF-OBS-03/04, RNF-03/04 · [05-test-plan.md](../05-test-plan.md) §2 e TST-I-16/17/18, TST-C-04/05/06/08/10 · [00-overview.md](../00-overview.md) R-06 · `adr/0002-spike.md` · código completo do `src/main.ts`, módulos de papel (publisher, consumidor, worker), `FaultInjector` e breaker.

## Pré-condições

`main` com W8 + W9 verdes (`typecheck`, `lint`, `test:unit`, `test:integration`, `test:concurrency`). `bun src/main.ts` sobe com os quatro papéis ligáveis por flag. Docker disponível para o gate.

## Ordem das tarefas e por quê

`T-052 → T-046 → T-053 → T-005b`. A **readiness** (T-052) é o que o helper de processos usa para saber que uma instância subiu; o helper de processos (T-046) é o que o teste de `SIGTERM` (T-053) usa; o `Dockerfile` (T-005b) só faz sentido com o app completo.

| Tarefa | Entrega | Testes que a fecham |
|---|---|---|
| **T-052** | `GET /health/live` e `GET /health/ready` | **TST-I-16**; reconfere **TST-I-17** |
| **T-046** | Helper de processos (`Bun.spawn`) + testes multi-instância | **TST-C-04, C-05, C-06 (b), C-08, C-10** |
| **T-053** | Shutdown ordenado (`SIGTERM`) | **TST-I-18** |
| **T-005b** | `Dockerfile` + `app1..3` no Compose + RAM completa | `docker compose up` do zero + smoke |

### T-052 — health

- **`live`**: 200 sem tocar em dependência (nem Postgres, nem SQS). **`ready`**: `SELECT 1` no Postgres e `GetQueueAttributes` das filas necessárias, cada um com timeout de **2 s**; 503 se banco fora, **fila inexistente**, **breaker aberto** (`isOpen()` da T-044) ou instância em **shutdown** (estado de ciclo de vida `draining`). Sem `@nestjs/terminus` (ADR-0018). Rotas abertas (`@Public()`).
- Crie o objeto de **estado de ciclo de vida** (`accepting` → `draining`) que a T-053 vai acionar; aqui o teste o altera diretamente.
- **Testes I-16 (em processo, infra real):** `live` 200 mesmo com o banco inalcançável (proxy TCP da W9 derrubado); `ready` 200 saudável; `ready` 503 com banco fora (proxy), com fila inexistente (config apontando para fila que não existe), com breaker aberto, e com o estado `draining`; os 503 de `ready` voltam a 200 quando a causa some (`eventually`); timeout de 2 s respeitado (dependência pendurada não pendura o health). **I-17 reconferido:** `/metrics` ainda expõe as 10 métricas e os contadores refletem o que a suíte provocou.

### T-046 — multi-processo

- **Helper** `test/support/spawnApp.ts`: sobe `bun src/main.ts` como **processo real** com env próprio (banco e filas da suíte, `PORT` livre obtido pelo helper, flags de papel, `TEST_FAULT`, `NODE_ENV=test`, config de tempos curtos), espera `GET /health/live` (e `ready` quando aplicável), expõe `pid`, `port`, `kill(signal)`, `waitExit()`, captura de stdout/stderr, `scrape()` de `/metrics`. Cada instância é encerrada no teardown mesmo se o teste falhar.
- **Testes (Postgres + SQS reais, 3 processos):**
  - **C-04:** ≥ 3 instâncias com todos os papéis ligados; carga HTTP distribuída em round-robin pelas 3 portas **e** mensagens SQS ao mesmo tempo, com duplicatas (mesma chave por HTTP e por SQS); ao final: efeito exato (cada operação aplicada uma vez), `assertLedgerInvariant` em todas as wallets, nenhuma 5xx inesperada.
  - **C-05:** instância com `TEST_FAULT=crash-after-commit-before-ack` processa uma mensagem → o **processo morre** (verifique o exit); a mensagem reaparece após a visibilidade; **outra instância** (sem falha) a consome → o inbox descarta → **um único efeito**.
  - **C-06 (b)** (N5): publisher com `crash-after-publish-before-commit` envia o lote e **morre antes do commit**; as linhas continuam não publicadas; **outra instância** republica os mesmos `eventId`; o consumidor de teste vê o `eventId` (possivelmente duplicado) e deduplica; todo evento esperado chegou.
  - **C-08:** sobe instância(s), envia tráfego incluindo operações idempotentes, **`SIGKILL`**, sobe de novo, **reenvia as mesmas operações** → respostas de replay (200, mesmo `transactionId`, `idempotentReplay: true`); tráfego novo; invariante final.
  - **C-10:** carga mista (muitas wallets, duplicatas, `REFUND`/`ROLLBACK`, pendentes) em 3 instâncias: **zero deadlock** (`pg_stat_database.deadlocks` do banco da suíte sem aumento **e** `lock_conflicts_total{type=deadlock}` = 0 em todas as instâncias via `scrape()`).
- Cuidados: portas livres reais; sem `sleep` fixo (`eventually`); 3 processos Bun + Postgres + emulador cabem em 8 GB (reporte o pico, R-06); saída dos processos anexada ao relatório quando o teste falhar.

### T-053 — shutdown ordenado

- `SIGTERM` na ordem de [03-messaging §8](../03-messaging.md): (1) readiness passa a falhar (`draining`); (2) HTTP deixa de aceitar conexões novas e **drena** as em curso; (3) consumidor para de buscar e espera os handlers por até `SHUTDOWN_GRACE_MS`; (4) handler que não terminou: mensagem **devolvida** (`ChangeMessageVisibility = 0`), **sem apagar**; (5) publisher termina o lote atual, worker de pendentes conclui a transação em curso; (6) fecha o pool e sai com código 0 dentro do prazo. `stop_grace_period: 30s` no Compose é da T-005b.
- **Teste I-18 (processo real, SQS real):** prenda uma wallet com `FOR UPDATE` numa conexão crua para que handlers fiquem em voo; envie mensagens; envie `SIGTERM`; verifique: a readiness vira 503 logo após o sinal; uma requisição HTTP em curso termina; **nenhuma mensagem é perdida** (ao final, soltando o lock e deixando outra instância trabalhar, toda mensagem terminou **exatamente uma vez** e a fila está vazia, `assertLedgerInvariant`); o processo sai com 0 dentro do prazo; variante com grace curto: handlers pendentes são **devolvidos**, não apagados.

### T-005b — Docker

- `Dockerfile` (imagem Bun fixada por tag) e serviços `app1`, `app2`, `app3` (mesma imagem, portas 3001–3003, `stop_grace_period: 30s`) no `docker-compose.yml`, com `depends_on` por healthcheck, criação das filas e **migrations** antes dos apps (proponha um serviço de uma execução só; evite 3 instâncias migrando ao mesmo tempo; reporte a escolha).
- `docker compose up --build` **do zero** (`docker compose down -v` antes) sobe tudo saudável. **Smoke** `bun run compose:smoke`: cria wallet e envia `BET` por **cada uma das 3 instâncias**, confere saldo, ledger e reconciliação (consistente) e sai 0.
- Meça a **RAM completa** (`docker stats --no-stream`, `free -m`) e anexe a `adr/0002-spike.md` (R-06).

## Gate

| # | Verificação | Esperado |
|---|---|---|
| 1 | `git status` limpo · `bun install --frozen-lockfile` · `typecheck` · `lint` | limpos |
| 2 | `bun run test:infra:up` · **`bun run test`** (unit + integration + concurrency), **3× seguidas** | verdes, 0 skip |
| 3 | IDs exigidos | **TST-I-16, I-17, I-18, TST-C-04, C-05, C-06 (b), C-08, C-10** |
| 4 | `docker compose down -v && docker compose up --build -d` | tudo saudável |
| 5 | `bun run compose:smoke` | exit 0 (saídas coladas) |
| 6 | RAM | pico registrado; cabe em 8 GB |
| 7 | Deadlocks | `pg_stat_database.deadlocks` = 0 após a suíte de concorrência |
| 8 | Elimináveis do README §14 | liste uma a uma com o teste/evidência que as cobre (rascunho para a W11) |

**Provas de dentes (obrigatórias):**
1. Apague a mensagem antes do commit → **C-05 vermelho** (efeito ausente/duplicado).
2. Remova o inbox → C-05 vermelho.
3. Faça o publisher marcar publicado antes de enviar, ou publicar antes do commit → C-06 (b) vermelho.
4. Remova o `FOR UPDATE` da wallet → C-04 e C-10 vermelhos.
5. Guarde a chave de idempotência só em memória → **C-08 vermelho**.
6. Pule a drenagem/devolução no shutdown → I-18 vermelho.
7. Faça `ready` ignorar o breaker/o `draining` → I-16 vermelho.

## Pare e pergunte se

Um dos testes multi-processo só passar com espera fixa ou retry mascarando falha; aparecer deadlock (`40P01`) real; o emulador se comportar de forma diferente entre processos; o Compose não couber em 8 GB; a escolha de quem roda as migrations afetar a spec; qualquer tarefa pedir mais de um commit.

## Fora do escopo

Documentação (W11), teste de carga e stretch (WS).

## Entregáveis

4 commits + relatório · suíte completa verde 3× · `docker compose up` do zero funcionando. **CP4:** código congelado.
