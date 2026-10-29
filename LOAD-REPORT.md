# Relatório de teste de carga

Stretch S-01 do desafio. Decisões e escopo em [ADR-0021](specs/adr/0021-teste-de-carga.md) (complementa o [ADR-0006](specs/adr/0006-concorrencia-lock-pessimista.md)). Comando: `bun run test:load`. **Não há meta de RPS**: o objetivo é medir com método e dizer o que o experimento permite e não permite concluir.

Todos os números abaixo vêm de **3 execuções completas** (`bun run test:load`, perfil `full`, mesma máquina, em sequência, 29/10/2026, 19:50–20:07 UTC), todas com saída 0 e a invariante do ledger verificada em 277 wallets cada. Os JSON brutos ficam em `test/load/results/` (ignorado pelo git).

## 1. Ambiente

| Item                        | Valor                                                                                                                                                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CPU                         | Intel Core i5-10310U @ 1,70 GHz, 8 threads lógicas (notebook)                                                                                                                                                                                                           |
| RAM                         | 7.942 MB totais                                                                                                                                                                                                                                                         |
| SO                          | WSL2, kernel 6.18.33.2-microsoft-standard-WSL2                                                                                                                                                                                                                          |
| Bun                         | 1.4.4                                                                                                                                                                                                                                                                   |
| PostgreSQL                  | 17.6 (container `docker-compose.test.yml`, porta 5433)                                                                                                                                                                                                                  |
| SQS                         | LocalStack 4.14.0 (emulador, porta 4567)                                                                                                                                                                                                                                |
| Instâncias da aplicação     | 3 processos `bun src/main.ts`, todos os papéis ligados (HTTP, consumidor, publisher da outbox, worker de pendências)                                                                                                                                                    |
| Pool de conexões            | `DB_POOL_MAX=10` por instância (igual ao padrão do Compose); `lock_timeout` 5 s e `statement_timeout` 15 s (padrões da aplicação)                                                                                                                                       |
| Temporizações               | as do helper de teste (`test/support/spawnApp.ts`): publisher da outbox a cada 100 ms (lote de 10), long-poll SQS de 1 s, `LOG_LEVEL=warn`. O Compose usa os padrões da aplicação (publisher a cada 500 ms), então a vazão de eventos aqui é **maior** que a do Compose |
| Gerador de carga e servidor | **na mesma máquina**                                                                                                                                                                                                                                                    |

Memória (RSS, medida ao fim de cada execução): instâncias 157–159 MB cada, gerador 117 MB; Postgres ≈ 448 MiB e LocalStack ≈ 325 MiB (`docker stats` logo após a execução, não é pico). Total ≈ 1,4 GB, abaixo do limite de ~2 GB.

CPU do gerador: **12–17 % de um núcleo** (máquina com 8 threads). Ele não foi o gargalo em nenhum cenário.

## 2. Metodologia

- **Cada execução** cria banco novo (clone de template migrado) e filas novas, sobe as 3 instâncias, roda os cenários em sequência e derruba tudo.
- **Gerador:** script Bun próprio, laço fechado (cada trabalhador envia a próxima requisição quando a anterior termina), `fetch` com timeout de 15 s. Cada requisição usa `Idempotency-Key` única, exceto as duplicatas deliberadas do N3. Valores monetários são strings. Distribui as requisições entre as 3 instâncias em rodízio.
- **Cenários HTTP** (10 s de aquecimento descartado + 30 s medidos):
  - **N1:** 200 wallets, 64 trabalhadores, `BET` de 1,00 a 5,00.
  - **N2:** **uma** wallet quente, 50 trabalhadores concorrentes, `BET`.
  - **N3:** 50 wallets, 64 trabalhadores, mix 70 % `BET`, 15 % `WIN`, 5 % duplicata (mesma chave e payload), 5 % `REFUND`, 5 % `LOSS`; cada `BET` concluída é referenciada no máximo uma vez.
  - **N4 (SQS):** 3.000 mensagens enfileiradas de uma vez por 20 remetentes em 20 wallets; mede até o consumo. A latência é `processed_at` menos o instante do envio, então **inclui a espera na fila** (é tempo de drenagem de um backlog, não latência por mensagem em regime).
- **Percentis:** método nearest-rank (cada valor reportado é uma latência observada, sem interpolação). O cenário N4 é medido no banco; os demais, no cliente.
- **O que é erro:** `5xx`, timeout, falha de conexão e qualquer `4xx` que o cenário não planejou. `422` esperado (por exemplo `INSUFFICIENT_FUNDS`) não é erro. Um `ECONNRESET` é reenviado **uma vez** com a mesma `Idempotency-Key` e contado à parte ("resets reenviados"); se o reenvio falha, é erro (ver §6).
- **Conflitos de lock:** `lock_conflicts_total`, somado nas 3 instâncias (delta por cenário). **Outbox lag:** `outbox_lag_seconds`, máximo entre amostras a cada 1 s nas 3 instâncias.
- **Verificação ao fim de cada cenário e da execução:** `assertLedgerInvariant` em todas as wallets tocadas, saldo nunca negativo, nenhum lançamento duplicado por (wallet, transação), saldo = inicial − Σ `BET` processadas nos cenários só de `BET`, outbox esvaziada e lag final ≤ 1 s, DLQ vazia no N4. Qualquer violação faz o comando sair com 1.

## 3. Resultados

Valores por execução (1ª / 2ª / 3ª). Taxa de erro 0 % em todos; resets reenviados: 0; `lock_conflicts_total`: 0; DLQ: 0.

| Cenário                        | req/s (média; faixa) | p50 ms                   | p95 ms                   | p99 ms                   | Outbox lag máx. (s) |
| ------------------------------ | -------------------- | ------------------------ | ------------------------ | ------------------------ | ------------------- |
| **N1** 200 wallets             | 303 (288–335)        | 212 / 204 / 182          | 365 / 391 / 297          | 507 / 615 / 400          | 30,1 / 25,7 / 29,5  |
| **N2** wallet quente, 50 conc. | 119 (110–126)        | 36 / 41 / 38             | 1.472 / 1.681 / 1.556    | 2.323 / 2.571 / 2.107    | 2,3 / 4,4 / 1,8     |
| **N3** mix                     | 333 (315–342)        | 186 / 177 / 186          | 370 / 323 / 286          | 496 / 411 / 343          | 30,0 / 29,9 / 29,9  |
| **N4** SQS, 3.000 msgs         | 92 msg/s (88–95)     | 14.490 / 15.531 / 14.321 | 20.376 / 21.028 / 20.023 | 21.446 / 21.815 / 20.724 | 0,2 / 0,3 / 0,2     |

No N3, as duplicatas deliberadas foram respondidas por replay (`200`: 515 / 546 / 545 por execução). O contador `idempotent_requests_total` somou 697 / 744 / 735 no mesmo cenário; não investiguei por que excede o número de `200` e não o uso como evidência. Ao fim de cada cenário a outbox esvaziou e o lag final foi 0.

**Leitura (o que os números mostram, sem extrapolar):**
- **Wallet quente (N2):** a vazão cai para ~40 % da do N1 e o p95 sobe de ~0,3–0,4 s para ~1,5 s, com p50 baixo (~38 ms). É o comportamento esperado do lock pessimista: as transações da mesma wallet se serializam e as demais esperam (cauda longa). Mesmo assim `lock_conflicts_total` ficou em 0, ou seja, nenhuma espera chegou ao `lock_timeout` de 5 s, e a invariante vale.
- **Outbox lag de ~30 s no N1 e no N3:** o lag cresceu ao longo dos 30 s medidos (≈ a duração da carga) e zerou depois dela. Em outras palavras, nessas condições a publicação dos eventos **ficou atrás** da escrita (~300 transações/s com um evento cada, publisher de 10 eventos por consulta). Isso é consistente com o lote pequeno e a latência de envio ao emulador, mas **a causa não foi isolada** (não medi o publisher separadamente). No N2, que escreve menos, o lag foi de 2 a 4 s.
- **SQS (N4):** ~90 mensagens/s de consumo de ponta a ponta, com o emulador. A latência de segundos é tempo de fila de um backlog de 3.000 mensagens, não latência por mensagem.

## 4. Comparação A × C (microbenchmark em SQL isolado)

A: `SELECT … FOR UPDATE` + `UPDATE` com guarda de `version` (a estratégia do projeto). C: `UPDATE wallets SET balance = balance - x … WHERE id = $1 AND balance >= x RETURNING …`. As duas rodam sobre as tabelas reais (`wallets`, `wager_transactions`, `wallet_ledger_entries`, com todas as constraints e triggers), gravam a mesma linha de transação e o mesmo lançamento de ledger na **mesma transação** e respeitam a ordem de locks do ADR-0007 (wallet antes de `wager_transactions`). 50 conexões `pg` na mesma wallet, 200 tentativas cada (10.000 por rodada), saldo para 6.000 débitos de 1,00 (4.000 rejeitadas por saldo). 3 rodadas alternadas por execução, 3 execuções: 9 rodadas por estratégia.

|                                                     | A (`FOR UPDATE`)       | C (`UPDATE` condicionado) |
| --------------------------------------------------- | ---------------------- | ------------------------- |
| Tentativas/s (média; faixa de 9 rodadas)            | 345 (307–363)          | 453 (385–501)             |
| p50 ms (faixa)                                      | 40–73                  | 29–46                     |
| p95 ms (faixa)                                      | 710–810                | 384–488                   |
| p99 ms (faixa)                                      | 1.452–1.735            | 608–819                   |
| Aceitas / rejeitadas por saldo                      | 6.000 / 4.000 em todas | 6.000 / 4.000 em todas    |
| `lock_timeout` / deadlocks / conflitos de `version` | 0 / 0 / 0              | 0 / 0 / 0                 |

Nas duas variantes o saldo final foi 0,00 = inicial − Σ débitos aceitos, nunca negativo, com um lançamento por débito aceito e a invariante do ledger válida. A variante C foi **cerca de 31 % mais rápida em vazão** e teve p95 e p99 aproximadamente pela metade, nesse arranjo.

**O que isso não prova.** É SQL contra SQL: sem HTTP, sem outbox, sem inbox, sem o `SubmitWagerTransaction` (idempotência, referências, estados, eventos). A diferença medida é a de segurar a linha por dois comandos (ler e depois atualizar) contra um só; ela não se transfere para a aplicação inteira, onde o tempo no banco é só parte do custo (no N2 a latência é de dezenas de ms no p50, e a cauda vem da fila no lock). A estratégia C empurra a regra de saldo para o SQL, não cobre a decisão de negócio completa (referências, reversões, estados) e deixa `Wallet.debit()` decorativo; por isso **a estratégia A continua sendo a do projeto** (ADR-0006), e este experimento não a muda. O que o experimento deixa como evidência é o custo da escolha: a wallet quente paga em vazão e cauda de latência, e a evolução natural (fila single-writer por wallet) está em [ARCHITECTURE.md §15](ARCHITECTURE.md#15-trade-offs-e-evolução).

## 5. Limitações e ruído

- Gerador, 3 instâncias, Postgres e LocalStack dividem **um notebook** (8 threads) sob WSL2. Os números são comparativos entre cenários e rodadas desta máquina, não absolutos, e não valem como capacidade do sistema em produção.
- **Emulador de SQS** (LocalStack), não o SQS da AWS. O N4 mede o emulador tanto quanto a aplicação.
- Gerador em laço fechado: a carga se ajusta à latência do servidor (não há taxa de chegada fixa); por isso a latência sob saturação é subestimada em relação a um gerador de taxa aberta.
- Variância entre as 3 execuções: vazão do N1 de 288 a 335 req/s (±8 %), N2 de 110 a 126 (±7 %), N3 de 315 a 342, N4 de 88 a 95. A cauda (p99) varia mais, até ~25 % no N1 (400 a 615 ms) e ~20 % no N2 (2.107 a 2.571 ms). Com 3 amostras, são faixas, não intervalos de confiança.
- Temporizações de teste (publisher a cada 100 ms) em vez dos padrões do Compose (500 ms); o lag da outbox no Compose tenderia a ser pior, não melhor, mas isso não foi medido.
- Execuções descartadas, registradas por transparência: duas execuções `full` anteriores à correção do gerador (§6) terminaram com 1 erro de conexão e saída 1, e uma terceira reproduziu o mesmo erro; foram descartadas e substituídas pelas três deste relatório. Execuções de verificação em perfil `smoke` não entram nos números.

## 6. O `ECONNRESET` raro

Em 3 de 6 execuções `full` anteriores houve exatamente 1 `ECONNRESET` ("The socket connection was closed unexpectedly") em ~8.000 requisições do N1 ou do N3, com a aplicação respondendo normalmente ao resto. É compatível com uma corrida de reuso de conexão keep-alive (o cliente reusa um socket que o servidor acabou de fechar), mas **não foi provado de que lado ocorre**, e `src/` não foi alterado. Decisão do autor: o gerador reenvia uma vez com a mesma `Idempotency-Key` e reporta o reset à parte. Nas 3 execuções finais não houve nenhum reset, então o contador ficou em 0; o evento existe, é raro e não foi diagnosticado.

## 7. O que não se pode concluir

- Que o sistema "aguenta X req/s" em outro hardware, com o SQS real ou com a rede entre os componentes.
- Que a estratégia C seria mais rápida **na aplicação**, ou que valeria trocar A por C; só se mediu SQL isolado.
- A causa do lag de ~30 s da outbox sob ~300 transações/s (lote de 10, latência do emulador ou outra) nem como ele se comporta com os padrões do Compose.
- Comportamento sob falhas (queda de instância, de banco) durante a carga; isso é coberto pelos testes de concorrência e de resiliência, não por este experimento.
- Estabilidade de longa duração: cada cenário mede 30 s.

## 8. Como reproduzir

```bash
bun run test:infra:up
bun run test:load                          # perfil full (~6 min), imprime a tabela e grava o JSON
bun run test:load -- --profile smoke       # ~15 s, o mesmo que o TST-I-22 roda
bun run test:load -- --scenarios N2 --skip-ab --duration-s 10 --hot-concurrency 100
```
Flags: `--profile smoke|full`, `--scenarios N1,N2,N3,N4`, `--duration-s`, `--warmup-s`, `--concurrency`, `--hot-concurrency`, `--instances`, `--seed`, `--skip-ab`, `--out`. O perfil `smoke` existe para o teste automatizado e **não serve** de referência de desempenho.
