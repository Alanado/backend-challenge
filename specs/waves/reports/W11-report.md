# Relatório W11 — Documentação e hardening
- Data/hora: 2026-10-28 · branch `wave/w11` · HEAD das tarefas: `3da0b8c` (o relatório é o commit seguinte)
- **Veredito: PARCIAL.** As 4 tarefas estão commitadas, os 3 conferidores passam e têm dentes, o Compose do zero e o smoke passam, `git diff main -- src` está vazio. **O gate 2 (`bun run test` 3× seguidas verde) NÃO foi satisfeito**: dois testes de integração da W10 (TST-I-11 e TST-I-15) são intermitentes. Código e testes não foram tocados (fora do escopo); a decisão é do autor (ver Perguntas).

Nota de retomada: uma sessão anterior já havia feito os 4 commits (T-060 a T-063) mas não deixou relatório nem evidência do gate. Esta sessão verificou o estado (árvore limpa, tarefas `[x]`), refez o gate inteiro e escreveu este relatório.

## Tarefas
| Tarefa | Commit | Verificação que a fecha | Resultado desta sessão |
|---|---|---|---|
| T-060 README | `4cd3866` (+ ajuste em `3da0b8c`) | `scripts/check-readme-commands.ts` (+ `test/unit/tooling/readme-commands.test.ts`); passos executados num clone limpo | conferidor: `ok (13 commands)`; passos do clone abaixo |
| T-061 ARCHITECTURE | `cfd86f7` | `scripts/check-architecture.ts` (+ `architecture-check.test.ts`) | `ok (15 sections, links and ADRs resolve)` |
| T-062 rastreabilidade | `41693cd` | `scripts/check-traceability.ts` (+ `traceability.test.ts`); `specs/traceability.md` gerado; `study-guide.md` atualizado | `ok (78 requirements, 45 tests, 47 tasks)`; regeneração deixa `git status` limpo |
| T-063 passada final | `3da0b8c` | itens abaixo | parcial (gate 2) |

Forma do README: o enunciado original está **intacto** (`git diff main -- README.md` não tem nenhuma linha removida); a seção do candidato foi acrescentada no topo, com aviso de onde começa o enunciado.

## Gate (saída real)
| # | Comando | Exit | Resumo |
|---|---|---|---|
| 1 | `bun install --frozen-lockfile` · `typecheck` · `lint` | 0 | "253 installs across 281 packages (no changes)"; tsc limpo; Biome 238 arquivos sem avisos |
| 2 | `bun run test` 3× (repositório) | 1, 1, 0 | unit 522/0 nas três; integração 471/1 fail, 471/1 fail, 472/0; concorrência 21/0 (só rodou na 3ª, pois `&&` interrompe após a falha da integração); 138 s, 141 s, 169 s. As falhas: `TST-I-11 a transient lock failure…` (timeout 5000 ms) nas duas |
| 2b | idem no **clone limpo** (3×) | 1, 1, 1 | unit 522/0; integração 462/10, 450/22, 451/21: TST-I-15 (10–21 testes) em todas, TST-I-11 em uma. Ver análise |
| 3 | `check-readme-commands` · `check-architecture` · `check-traceability` | 0 ×3 | mensagens acima, também no clone |
| 4 | clone limpo + README literal | ver abaixo | funciona, exceto a suíte (gate 2b) |
| 5 | `docker compose down -v && up --build -d --wait` (clone) + `compose:smoke` | 0 | postgres, sqs, app1..3 `healthy`, `migrate` `Exited (0)`, 21 s; smoke: BET 201 PROCESSED pelas 3 instâncias, saldo `70.00` nas três, ledger versões `[4,3,2,1]`, reconciliação `consistent: true`, `checkedEntries: 4`, `smoke ok` |
| 6 | checklist das eliminatórias | — | 8 linhas abaixo |
| 7 | `git diff main -- src` | vazio | nenhum código de produção alterado (diff total: README, ARCHITECTURE, 3 scripts + libs, 3 testes de ferramentas, `traceability.md`, `study-guide.md`, `06-tasks.md`) |

### Passos do clone limpo (executados nesta ordem em `git clone` da branch, HEAD `3da0b8c`)
`bun install --frozen-lockfile` (252 packages) → `check-readme-commands`/`check-architecture`/`check-traceability` (ok; árvore continuou limpa) → `typecheck`, `lint` (ok) → `docker compose down -v; docker compose up --build -d --wait` (healthy) → `bun run compose:smoke` (exit 0) → exemplos de `curl` do README: criar wallet 201, `BET` 201, replay por outra instância 200 `idempotentReplay: true` com saldo `975.00`, `POST /wallets/:id/reconciliation` 200, `/health/ready` 200 nas 3 portas, `/metrics` com `wager_transactions_total` → `docker compose down -v` → `bun run test:infra:up` → `bun run test` 3× (gate 2b). Não reexecutei os exemplos de reversão/ledger/DLQ do README além dos cobertos pelo smoke.

### Análise da instabilidade (gate 2)
- **TST-I-11 `a transient lock failure…`** (`test/integration/sqs-consumer-inbox.test.ts`): falha por timeout de 5 s do teste em ~1 de 3 execuções do arquivo, isolado ou na suíte, com infra velha ou recém-criada (também falhou uma vez o outro teste do arquivo, "the ack follows the commit…"). O próprio teste comenta que um long poll abandonado por um teste anterior pode engolir a mensagem uma vez no emulador; o teste só tem os 5 s padrão para o ciclo receber → falhar lock → backoff de 1 s → rereceber.
- **TST-I-15** (`test/integration/queries-http.test.ts`): o primeiro teste faz 210 `BET`s via HTTP em um processo real e tem o timeout padrão de 5 s; quando estoura, o `afterAll` mata o processo e os 20 testes seguintes viram `ECONNREFUSED` (por isso 10–21 falhas). Medi: com `--timeout 60000` passa sempre; e, minutos depois das falhas, o arquivo passou 30/30 com o timeout padrão. Ou seja, está na margem do timeout e depende da velocidade da máquina naquele momento. Na W10 as 3 execuções passaram; aqui o WSL estava mais lento (carga ≈ 3 na mesma máquina).
- Nenhuma das duas falhas é causada por esta onda: `src/` e esses arquivos de teste são idênticos aos da `main`.
- **Não corrigi.** Corrigir exigiria alterar teste da W10 (timeouts maiores ou reduzir o volume), fora das tarefas T-060–T-063; o protocolo manda parar e perguntar.

### Cobertura (`bun test --coverage`)
Sem limite numérico. Só a execução da unitária é limpa: `test/unit` 522 pass, **83,56 % de linhas / 86,54 % de funções**. Com `--coverage` a integração (451 pass / 21 fail, 91,64 % linhas) e a concorrência (18 pass / 3 fail, 73,09 % linhas) estouram timeouts (a instrumentação deixa mais lentos os testes que sobem processos filhos; as falhas são TST-I-15 e C-11/C-12), então os números dessas duas são **indicativos, não confiáveis**. Rodar as três pastas num só processo (`bun test --coverage` sem pasta, como cita o README) produziu 24 falhas por interferência entre suítes; **o README sugere esse comando e ele não é o modo suportado** (ver Perguntas). Caminhos com baixa cobertura na integração (linhas): `ledger-cursor.ts` 0 % e `list-wallet-ledger.ts` 50 % (consequência da falha do I-15 sob coverage), `reconcile-wallet.ts` 50 %, `get-wager-transaction.ts` 20 %, `metrics.ts` 30 %, `shared/errors.ts` 33 %; eles são exercitados por outras suítes (HTTP de reconciliação, concorrência), que a medição por pasta não soma.

## IDs de teste exigidos × encontrados
`check-traceability` confere todos os `TST-*` do `05-test-plan` contra os títulos em `test/`: nenhum ausente (78 requisitos, 45 testes citados, 47 tarefas, nenhuma `[ ]`). Matriz em `specs/traceability.md`.

## Provas de dentes
| Mutação aplicada (sem commitar) | Resultado | Restaurado |
|---|---|---|
| `TST-C-08` renomeado para `TST-X-08` em `multi-instance-restart.test.ts` | `check-traceability` exit 1: "TST-C-08 is in the test plan but no test title cites it" | sim (`git checkout`, árvore limpa) |
| link `adr/0010-reversao-unica-por-referencia.md` trocado por `…-quebrado.md` no `ARCHITECTURE.md` | `check-architecture` exit 1: "line 189: link to missing file" | sim |
| `## 11. Autenticação` renomeado no `ARCHITECTURE.md` | exit 1: "section 11 is missing" + âncora do índice quebrada | sim |
| script `test:unit` renomeado para `test:unitx` no `package.json` | `check-readme-commands` exit 1: "1 unknown target(s)" | sim |

## Checklist das eliminatórias (README §14)
| Eliminatória | Evidência |
|---|---|
| `number` para dinheiro | varredura em `src/` por `amount/balance/…: number`, `parseFloat`: nada (único `toFixed` é `Money.toString`, `src/shared/money.ts:95`); TST-U-01 (rejeita `number` em runtime), TST-U-02 (precisão além de `number`; "source has no conversion to number") em `test/unit/shared/money.test.ts`; coluna `NUMERIC(19,2)` |
| Saldo negativo por race | TST-C-02, C-12 (`funds-and-idempotency.test.ts`), `CHECK` (TST-I-02: `schema-constraints`, `ledger-constraints`); C-12 e a concorrência inteira (21 testes) só rodaram, sem coverage, na 3ª execução do repositório (verde); nas demais o `&&` parou antes. Provas de dentes na W10 (#4) |
| Débito/crédito duplicado | TST-C-01, C-11 (`locking.test.ts`), C-05 (`multi-instance-consumer-crash`), UNIQUEs |
| Idempotência só em memória | TST-C-08 (SIGKILL + novo processo), `UNIQUE` no banco; prova de dentes W10 #5 |
| Correto só com uma instância | TST-C-04 (`multi-instance-load`), C-05, C-06(b), C-08, C-10 com processos reais; `compose:smoke` com 3 instâncias |
| Publicação antes do commit | TST-I-05 (`submit-wager-transaction`), I-13 (`outbox-role`, `outbox-publisher`), C-06 (`outbox-publishers`, `multi-instance-publisher-crash`); prova W10 #3 |
| Ausência de ledger auditável | TST-I-03 (`ledger-constraints`, triggers), I-14 (`reconciliation-http`, `transaction-manager`), `assertLedgerInvariant` |
| Mocks no lugar de PG/SQS | `grep -rniE "mock\(\|jest\.\|spyOn\|mock\.module\|vi\.mock" test` vazio; testes de integração/concorrência importam `pg` e `@aws-sdk/client-sqs` reais (conexão ao Compose de teste) |

Observação: as evidências dos testes citados vêm dos testes que passaram nas execuções verdes; a intermitência acima não envolve nenhum desses IDs, exceto o I-15 (paginação, não eliminatória).

## Varreduras
- `grep -rnE "\.(skip|todo|only)\b|xit\(|xdescribe\(" test src`: vazio.
- `console.*` em `src/`: 4 ocorrências, todas em `src/main.ts` (linhas JSON de boot/parada sem valores; erro de configuração; falha de shutdown/start). Nenhuma loga dados de negócio. Não é `console.log` de depuração, mas o protocolo pedia a varredura: registrado.
- Segredos: `grep` por `secret|password|api key|token = "…"`, `AKIA…`, chaves privadas: nada (credenciais de teste fictícias só em `.env.example`/compose).
- `TEST_FAULT`: só em `src/shared/config.ts` e `fault-injector.ts`; `config.ts:182` recusa com `NODE_ENV=production`; teste em `test/unit/shared/config.test.ts`.
- Arquivos versionados: nenhum `node_modules`, `.env`, `coverage` ou `dist`; só `.env.example`; `.gitignore` cobre `node_modules`, `.env`, `coverage`, `dist`.

## Desvios, decisões, dependências adicionadas
- Dependências novas: nenhuma. Código de produção, ADRs e specs numeradas: não alterados. `study-guide.md` e `06-tasks.md` foram alterados dentro das tarefas T-062/T-060–T-063.
- `CLAUDE.md` (fora do escopo, **não editei**): ainda diz "a criar" para `docker compose up --build` e não lista `compose:smoke` (pendência herdada do relatório da W10).
- `bun test --coverage` no README: ver Perguntas.

## Perguntas em aberto / bloqueios
```
Problema: o gate 2 ("bun run test 3× verde") falhou. TST-I-11 (sqs-consumer-inbox.test.ts) falhou
em ~1/3 das execuções e TST-I-15 (queries-http.test.ts, primeiro teste com 210 BETs) estoura os
5 s padrão quando a máquina está mais lenta e derruba 10–21 testes do arquivo. Código/teste
idênticos aos da main (W10); passaram 3× na W10. Evidência: seção "Análise da instabilidade".
Opções: (A) fechar a W11 como está, com a ressalva no relatório e entregar com a instabilidade
conhecida (rápido, mas a suíte pode falhar na correção); (B) uma onda/commit de correção só de
testes: timeout explícito maior no primeiro teste do I-15 e no I-11 (ou menos BETs / backoff
menor no I-11), sem tocar produção (pequeno e seguro, mas exige reabrir testes da W10 e repetir o
gate 3×); (C) além de B, investigar o long poll abandonado que engole a mensagem no I-11 (mais
trabalho, ataca a causa).
Recomendação: B, em commit `test(...)` separado, antes de entregar o projeto.
Explicação: a instabilidade é só de margem de tempo; B não muda garantia alguma e o gate 3× da
W11 passaria a poder ser provado. Nada nas tarefas T-060–T-063 muda.
```
```
Problema: o README (seção Testes) sugere `bun test --coverage` para "tudo, com test:infra:up",
mas rodar as três pastas em um processo produz 24 falhas por interferência entre suítes; o
modo suportado é por pasta (como `bun run test`), e com --coverage a integração/concorrência
estouram timeouts.
Opções: (A) ajustar o README para `bun test --coverage test/unit` e documentar que a
cobertura de integração/concorrência é indicativa; (B) deixar como está.
Recomendação: A (correção de documentação, um commit `docs(readme)`).
Explicação: a documentação deve descrever o que o código faz. Não alterei porque a onda já tinha
os 4 commits fechados e o protocolo permite só o commit do relatório fora das tarefas.
```
Também aguarda decisão: atualizar o `CLAUDE.md` (comandos "a criar").

## Pré-condições para a entrega
Documentação, conferidores, rastreabilidade e Compose prontos; falta só decidir a estabilização dos dois testes intermitentes (e rodar o gate 2 de novo) para declarar o projeto pronto.
