# WS-01 — `bun run test:load` (stretch S-01)

**Slot:** quinta 29/10, tarde e noite · **Branch:** `wave/ws-01` (a partir da `main` **com a W12 mergeada**) · **Depende de:** W12 · **Tamanho:** M (2–3 h, com **limite duro às 22:00**) · **Detalha:** a seção S-01 de [WS-stretch.md](WS-stretch.md)

Decisão do autor (2026-10-29): fazer **somente o S-01** dentro do tempo disponível. S-02 a S-06 ficam como evolução documentada.

## Regras específicas desta onda

1. **`src/` não muda.** `git diff main -- src` vazio ao fim. O experimento A × C **não** pode introduzir flag nem caminho alternativo no código de produção (a estratégia padrão não está em jogo, [ADR-0006](../adr/0006-concorrencia-lock-pessimista.md)).
2. **Passo 0 é obrigatório** ([WS-stretch §regras](WS-stretch.md)): antes de qualquer código, a sessão traz as decisões abaixo no formato Problema/Opções/Recomendação/Explicação e **aguarda a resposta**. As recomendações já estão aqui para o autor só vetar.
3. **Limite duro:** se às 22:00 de quinta o gate não estiver verde, **a branch não é mergeada**; o relatório registra `PARCIAL`, o README continua dizendo "não implementado" e a entrega segue sem o stretch. Nunca deixar a `main` quebrada.
4. Nada do que está verde regride: `bun run test` 3× ao fim.
5. Honestidade acima de número ([README do desafio §14](../../README.md)): sem meta de RPS; o relatório diz o que **não** se pode concluir.

## Prompt (cole na sessão)

```text
Você é a sessão executora do stretch S-01 — bun run test:load do desafio Distributed Wagering Processor.
Trabalhe dentro do WSL, na pasta do repositório, branch wave/ws-01, criada a partir da main (W0–W12 verdes, W12 já mergeada). Bun em ~/.bun/bin.
Leia nesta ordem: CLAUDE.md, specs/README.md, specs/waves/_common.md, specs/waves/WS-stretch.md (regras comuns e seção S-01) e specs/waves/WS-01-test-load.md, mais os documentos da lista "Leitura" desta onda.
PASSO 0 (obrigatório): ANTES de escrever código, traga ao autor as decisões da seção "Passo 0" de WS-01-test-load.md no formato Problema/Opções/Recomendação/Explicação e aguarde a resposta. Depois da aprovação, registre o ADR-0021 (complementa o ADR-0006) e só então implemente: testes primeiro, um commit por tarefa (S-01a…S-01d), protocolo de _common.md.
Código de produção (src/) NÃO pode mudar. Limite duro: 22:00 de quinta; se não estiver verde, não mergeie e registre PARCIAL.
Ao final: gate, specs/waves/reports/WS-01-report.md e veredito com evidência.
```

## Leitura

[README do desafio §14](../../README.md) (parágrafo de teste de carga) · [ADR-0006](../adr/0006-concorrencia-lock-pessimista.md) (alternativas A e C) · [ADR-0014](../adr/0014-outbox-e-eventos.md) · [04-api](../04-api.md) §7 (métricas) · [05-test-plan](../05-test-plan.md) §1–2 · `test/support/` (spawn de instâncias, banco/filas por suíte, `assertLedgerInvariant`, `eventually`) · `test/concurrency/multi-instance-load.test.ts` (TST-C-04) · `scripts/compose-smoke.ts` · `docker-compose.test.yml`.

## Passo 0 — decisões em aberto e recomendações

| # | Problema | Opções | Recomendação |
|---|---|---|---|
| L-1 | Ferramenta de carga | (a) script Bun próprio (`fetch`, `Promise` pool) · (b) k6 em container | **(a).** Sem dependência nova, sem RAM extra (8 GB), reaproveita os helpers de teste. k6 só se justifica com roteiro complexo. |
| L-2 | Onde roda | (a) 3 instâncias via `Bun.spawn` sobre a infra de teste (5433/4567), banco e filas novos por execução · (b) contra o Compose de dev (3001–3003) | **(a).** Mesmo mecanismo já provado (TST-C-04), isolado, não suja o banco de dev, e o comando roda do zero após `test:infra:up`. |
| L-3 | Cenários | N1: wallets distintas (200 wallets, HTTP) · N2: **wallet quente** (50 concorrentes na mesma wallet) · N3: mix (70 % `BET`, 15 % `WIN`, 5 % duplicata, 5 % `REFUND`, 5 % `LOSS`) via HTTP e **via SQS** | **N1 + N2 + N3 (HTTP) + um cenário SQS** (enfileira N mensagens e mede até o consumo). |
| L-4 | Duração e rampa | fixa por requisições vs. por tempo | **Por tempo:** 10 s de aquecimento (descartado) + 30 s medidos por cenário; perfil `--profile smoke` (≈ 5 s) para o teste automatizado. Duração e concorrência por flag. |
| L-5 | Como comparar A (pessimista) × C (`UPDATE` condicionado) sem tocar na produção | (a) flag de experimento no `src/` · (b) **microbenchmark isolado em `test/load/`**: duas funções SQL (A: `SELECT … FOR UPDATE` + `UPDATE`; C: `UPDATE wallets SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING …`) sobre a mesma tabela `wallets` real, 50 conexões na mesma wallet, ledger inserido igual nas duas · (c) não comparar | **(b).** Mantém `src/` intocado e a comparação honesta: é **SQL contra SQL, não ponta a ponta**; o relatório diz isso e não extrapola. Ambas as variantes terminam com a invariante verificada. |
| L-6 | Onde fica o relatório | (a) `specs/waves/reports/WS-01-report.md` (processo) + `docs/` ou seção própria · (b) um único `LOAD-REPORT.md` na raiz | **(b) `LOAD-REPORT.md` (PT-BR) na raiz**, linkado no README e no `ARCHITECTURE.md`; o relatório de onda só aponta para ele. |
| L-7 | O que o comando faz com o relatório | só imprime · gera arquivo | **Imprime a tabela e grava JSON** em `test/load/results/` (ignorado pelo git); o `LOAD-REPORT.md` é escrito à mão a partir de uma execução real, com ambiente medido. |

Respondidas as decisões, a sessão escreve o **ADR-0021** (novo, complementa o 0006: "teste de carga e comparação A × C em microbenchmark isolado") e acrescenta o ponteiro em `specs/README.md`/`07-waves.md` **antes** do código.

## Tarefas (quatro commits; se alguma exigir dois, pare e proponha o corte)

Em `06-tasks.md` o item S-01 vira S-01a…S-01d (planejado em 2026-10-29).

| Tarefa | Entrega | Testes que a fecham |
|---|---|---|
| **S-01a** | Biblioteca de medição: histograma/percentis (p50/p95/p99), contagem por status HTTP, taxa de erro, cronômetro; `test/load/lib/` | `TST-U-15` |
| **S-01b** | Cenários N1–N3 + SQS, spawn de 3 instâncias, coleta de `/metrics` (`lock_conflicts_total`, `outbox_lag_seconds`), verificação final da invariante, script `test:load` | `TST-I-22` (perfil smoke) |
| **S-01c** | Microbenchmark A × C com 50 concorrentes na mesma wallet, invariante verificada nas duas | `TST-I-23` |
| **S-01d** | `LOAD-REPORT.md` + README (`test:load` documentado, remoção de "não foi implementado") + `ARCHITECTURE.md` (§14 e §15) | `check-readme-commands`, `check-architecture`, `check-traceability` |

### S-01a — medição (TDD puro, sem I/O)

`TST-U-15`: percentis por interpolação ou nearest-rank (a escolha vai documentada no relatório), casos de borda (1 amostra, amostras iguais, vazio → erro explícito), taxa de erro = `não-2xx esperados` separados de erros inesperados (um `422 INSUFFICIENT_FUNDS` esperado **não** é erro de carga; `5xx`, timeout e conexão são), soma por status. **Dinheiro nos geradores de carga é string**, nunca `number`.

### S-01b — cenários e invariante

- Uma execução = banco e filas novos (mesmos helpers do `test/support`), 3 instâncias `Bun.spawn`, pool e flags iguais aos do Compose.
- Cada requisição usa `Idempotency-Key` única (exceto as duplicatas deliberadas do N3).
- Coleta, ao fim de cada cenário: `lock_conflicts_total`, `outbox_lag_seconds` (máximo observado em amostras a cada 1 s), `idempotent_requests_total`, `wager_transactions_total` por status.
- **Invariante:** após a carga, `assertLedgerInvariant` em **todas** as wallets tocadas; qualquer violação faz o comando sair com código ≠ 0. Também confere: nenhuma wallet com saldo negativo, nenhum débito duplicado (contagem de lançamentos por transação), outbox esvaziando (lag final ≈ 0 com `eventually`, sem `sleep` fixo).
- Saída: tabela por cenário (throughput, p50/p95/p99, taxa de erro, conflitos, lag) + JSON.
- `TST-I-22`: `bun run test:load -- --profile smoke` (≈ 5 s por cenário) sai 0, imprime todos os campos exigidos e a invariante vale. Integração com infra real, determinístico (sem asserts de número de RPS).

### S-01c — A × C

- Tabela `wallets` real com as constraints (a variante C também grava o ledger na mesma transação, para a comparação ser justa).
- 50 clientes `pg` concorrentes, cada um tentando N débitos de valor fixo na mesma wallet (saldo suficiente só para parte deles); mede throughput, latência, quantas rejeitadas por saldo, tentativas, `lock_timeout`/deadlocks.
- `TST-I-23`: em ambas as variantes o saldo final = saldo inicial − Σ débitos aceitos, nunca negativo, número de lançamentos = débitos aceitos; roda em perfil curto.
- O relatório compara e **limita a conclusão**: SQL isolado, sem HTTP, sem outbox, sem inbox; C não cobre a decisão de negócio completa (referências, estados), por isso A é a estratégia do projeto.

### S-01d — relatório e docs

`LOAD-REPORT.md` com: **ambiente** (CPU, núcleos, RAM, WSL/kernel, versões de Bun/Postgres/LocalStack, pool, instâncias, `DB_POOL_MAX`), **metodologia** (cenários, duração, aquecimento, geração de carga, o que é erro), **resultados** (throughput, p50/p95/p99, taxa de erro, `lock_conflicts_total`, outbox lag), **A × C** com análise, **limitações e ruído** (gerador de carga e servidor na mesma máquina, WSL, emulador SQS ≠ SQS real, variância entre execuções — rode cada cenário **3×** e reporte a dispersão), e **o que não se pode concluir**. Números só de execuções reais registradas.

## IDs novos

`TST-U-15`, `TST-I-22`, `TST-I-23` — registrados em `05-test-plan.md` na S-01a/b/c (acréscimo aditivo). Sem RF/RNF novo: o stretch não cria requisito obrigatório.

## Provas de dentes

| Mutação (sem commitar) | Esperado |
|---|---|
| Remover o `FOR UPDATE` na variante A do microbenchmark (ou no `src/` apenas durante a prova, restaurando) | invariante do `test:load`/`TST-I-23` falha |
| Adulterar o gerador para enviar `amount` com 3 casas | taxa de erro inesperada > 0 e o comando sai ≠ 0 |
| Fazer o percentil devolver a média | `TST-U-15` falha |
| Inserir uma divergência saldo × ledger por SQL no fim da carga | o passo de verificação sai ≠ 0 |

## Commits esperados

```
docs(adr): adiciona ADR-0021 de teste de carga e comparação das estratégias
test(load): adiciona biblioteca de medição de latência e erros (S-01a)
feat(load): adiciona cenários de carga e verificação da invariante (S-01b)
test(load): compara lock pessimista e update condicionado em sql isolado (S-01c)
docs(load): documenta o teste de carga e seus limites (S-01d)
docs(waves): adiciona relatório da WS-01
```

## Gate

[_common §9](_common.md) mais: `bun run test:load` roda **do zero** (após `test:infra:up`) e sai 0; `LOAD-REPORT.md` contém ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos de lock, outbox lag, A × C e limitações; `git diff main -- src` vazio; `bun run test` 3× verde; três conferidores verdes; README sem a frase "não foi implementado" para `test:load`.

## Armadilhas

- Não deixe o gerador de carga virar o gargalo: meça a CPU do processo gerador; se estiver saturado, o relatório diz.
- A suíte de carga **não** entra no `bun run test` (demora e é ruidosa); só o perfil smoke, via `TST-I-22`, roda na suíte de integração. Confirme que o tempo total da suíte não passa de +15 s.
- Portas fixas de teste (5433/4567) e três portas HTTP: use portas livres escolhidas pelo helper, nunca 3001–3003.
- RAM: 3 instâncias + Postgres + LocalStack + gerador; meça e registre. Se passar de ~2 GB, reduza concorrência por flag.
- Se o WSL for suspenso durante a medição, descarte a execução e registre.
