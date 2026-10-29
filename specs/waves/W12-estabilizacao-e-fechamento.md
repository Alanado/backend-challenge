# W12 — Estabilização dos testes e fechamento de interpretação

**Slot:** quinta 29/10, início da tarde · **Branch:** `wave/w12` (a partir da `main`, que contém W0–W11) · **Depende de:** W11 · **Libera:** WS-01 e a entrega · **Tamanho:** P (≤ 1,5 h)

Origem: análise de prontidão de 2026-10-29 (sessão de revisão). Duas decisões do autor, ambas na opção recomendada:

| # | Problema | Decisão do autor (2026-10-29) |
|---|---|---|
| D12-1 | `TST-I-16` (`health.test.ts`, "an open circuit breaker…") estourou o timeout padrão de 5 s numa execução completa (471 pass / 1 fail); isolado, passou 6/6. O teste leva ≥ 3 s por desenho (cooldown do breaker). Mesma classe do I-11 e do I-15 já corrigidos na W11. Como o script `test` usa `&&`, a falha de integração impede a suíte de concorrência de rodar. | **Opção B:** timeout padrão maior e global para a suíte (configuração), sem tocar em `src/`; repetir o gate 3×. Não mudar o `&&`. |
| D12-2 | `REFERENCE_ALREADY_REVERSED` vale para qualquer comando com referência, inclusive `WIN`/`LOSS` que apontam para uma `BET` já revertida (`ARCHITECTURE.md` §14, "aguarda confirmação do autor"). Não há teste dedicado. | **Opção A:** manter o comportamento, **acrescentar o teste** e registrar a interpretação como confirmada. **Não** restringir a regra (isso exigiria ADR e mexeria no núcleo financeiro a um dia da entrega). |

## Prompt (cole na sessão)

```text
Você é a sessão executora da Onda W12 — Estabilização dos testes e fechamento de interpretação do desafio Distributed Wagering Processor.
Trabalhe dentro do WSL, na pasta do repositório, branch wave/w12, criada a partir da main (W0–W11 verdes). Bun em ~/.bun/bin.
Leia nesta ordem: CLAUDE.md, specs/README.md, specs/waves/_common.md e specs/waves/W12-estabilizacao-e-fechamento.md, mais o relatório specs/waves/reports/W11-report.md (seção "Análise da instabilidade").
Execute APENAS T-070, T-071 e T-072, nesta ordem, um commit por tarefa, protocolo de _common.md (testes primeiro, depois o mínimo). Código de produção (src/) NÃO pode mudar: `git diff main -- src` tem de ficar vazio. Não altere ADRs. Se o comportamento real de WIN/LOSS com referência já revertida divergir do descrito na T-071, PARE e pergunte no formato Problema/Opções/Recomendação/Explicação.
Ao final: rode o gate, escreva specs/waves/reports/W12-report.md e informe o veredito com a evidência.
```

## Leitura

[W11-report](reports/W11-report.md) (instabilidade e addendum) · [ARCHITECTURE.md](../../ARCHITECTURE.md) §10 e §14 · [01-requirements](../01-requirements.md) RF-TXN-11/13 e §12 · [02-design](../02-design.md) §5 (ordem de checagem da referência) · [ADR-0010](../adr/0010-reversao-unica-por-referencia.md) · [05-test-plan](../05-test-plan.md) §2 e §4 · `test/integration/health.test.ts`, `test/integration/submit-wager-transaction.test.ts` (padrão de teste e helpers) · `package.json`.

## Pré-condições

`main` limpa, `bun run test:infra:up`, `typecheck` e `lint` verdes. Registre, antes de mexer, a linha de base: `bun run test:integration` (anote falhas, se houver).

## Tarefas

| Tarefa | Entrega | Verificação que a fecha |
|---|---|---|
| **T-070** | Timeout padrão de teste global e suficiente para máquinas lentas | teste de ferramenta + gate 3× + prova de dentes |
| **T-071** | `TST-I-21`: `WIN`/`LOSS` com referência a `BET` já revertida | teste de integração (vermelho só se o comportamento divergir) |
| **T-072** | Documentar a interpretação confirmada e a estabilização | `check-architecture` + `check-traceability` |

### T-070 — timeout padrão global

1. **Descobrir o mecanismo** (primeiro passo, 5 min): o `bunfig.toml` do Bun 1.4.4 aceita `[test] timeout = …`? Teste com um arquivo descartável (não commitado) que dorme 6 s com `eventually`/`await Bun.sleep` apenas para esta medição. Se `bunfig` não valer, use `--timeout 30000` nos scripts `test:integration` e `test:concurrency` do `package.json` (e em `test:unit` só se necessário). Reporte qual mecanismo funcionou.
2. **Valor:** 30 000 ms como padrão. Os timeouts explícitos já existentes nos testes (20 s e 30 s da W11) continuam valendo e não são removidos.
3. **Teste primeiro:** `TST-U-14` em `test/unit/tooling/test-timeout.test.ts`: lê a configuração efetiva (bunfig e/ou scripts) e falha se o timeout padrão for inferior a 20 000 ms ou ausente. Veja-o vermelho antes da configuração.
4. Nada de `sleep` fixo novo, nada de `skip`.

**Prova de dentes (melhor esforço):** reproduza a "máquina lenta" rodando `TST-I-16` e `TST-I-11` com `--timeout 5000` enquanto 2 processos `yes > /dev/null` saturam a CPU (ou `nice`/`taskset`); registre se o timeout padrão antigo falha e o novo passa. Se a falha não reproduzir, registre a tentativa honestamente; **não** invente a evidência. A prova obrigatória é o `TST-U-14` vermelho → verde e a configuração removida → `TST-U-14` falha.

### T-071 — `TST-I-21` (cruzamento WIN/LOSS × reversão)

Cenário, em `test/integration/` (arquivo novo, `reversal-reference-cross.test.ts`, ou no arquivo de reversões existente se for o padrão):

1. Wallet com `100.00`. `BET 25.00` → `PROCESSED` (saldo `75.00`). `REFUND` da `BET` → `PROCESSED` (saldo `100.00`).
2. `WIN 10.00` com `referenceExternalTransactionId` = a `BET` → esperado `REJECTED` / `REFERENCE_ALREADY_REVERSED` (HTTP 422), saldo e `version` inalterados, **nenhum** lançamento novo, transação persistida (auditável).
3. Idem para `LOSS` referenciando a mesma `BET`.
4. Controle: um `WIN` referenciando uma `BET` **não revertida** continua `PROCESSED` (a regra não pode ter virado "WIN com referência nunca passa").
5. `assertLedgerInvariant` ao final; replay do `WIN` rejeitado responde o mesmo resultado (`idempotentReplay: true`).

Registre o `TST-I-21` em `05-test-plan.md` (§4) e cite-o em `RF-TXN-11` de `01-requirements.md` (acréscimo aditivo, autorizado por este plano). **Se o comportamento real divergir do esperado (por exemplo `WIN` passa), não altere `src/`: pare e pergunte.**

**Prova de dentes:** sem commitar, faça a checagem de "já revertida" ignorar `WIN`/`LOSS` (ou remova-a) → `TST-I-21` precisa falhar; restaure.

### T-072 — documentação

1. `ARCHITECTURE.md` §14: troque o item "aguarda confirmação do autor" por registro da confirmação (data 2026-10-29) e mova a regra para a §10 (Interpretações) como interpretação 10: "`WIN`/`LOSS` com referência a uma transação já revertida são `REJECTED REFERENCE_ALREADY_REVERSED`", citando o `TST-I-21`.
2. `01-requirements.md` §12: acrescente a interpretação 10 (aditivo; nenhum ADR muda).
3. `ARCHITECTURE.md` §13/§14: uma linha sobre o timeout padrão global e por que existe (margem para máquinas lentas; testes com cooldown/ciclo de backoff reais levam segundos).
4. `scripts/check-architecture.ts` e `scripts/check-traceability.ts` verdes; `specs/traceability.md` regenerado no mesmo commit.

## Commits esperados

```
test(tooling): define timeout padrão global dos testes (T-070)
test(integration): cobre WIN e LOSS com referência já revertida (T-071)
docs(architecture): registra a interpretação confirmada e a estabilização (T-072)
docs(waves): adiciona relatório da W12
```

## Gate

Além do gate comum ([_common §9](_common.md)):

1. `bun run test` **3× seguidas verdes** (unit 523+, integração 473+, concorrência 21+) — **sem** usar `&&` para esconder falha: se a integração falhar, rode também `bun run test:concurrency` e reporte as duas.
2. `git diff main -- src` **vazio**.
3. `TST-U-14` e `TST-I-21` presentes (`grep`).
4. `health.test.ts` e `sqs-consumer-inbox.test.ts` 6× cada, sem falha.
5. Os três conferidores (`check-readme-commands`, `check-architecture`, `check-traceability`) com exit 0 e `git status` limpo depois.

## Armadilhas

- Subir o timeout global **não** é desculpa para testes lentos novos: nenhum teste novo pode depender dele.
- Não mexer em `--coverage` nem no README além do necessário (o stretch cuida de `test:load`).
- A suspensão do WSL já gerou uma falha espúria de `TST-C-07` (W11, addendum). Se `C-07` falhar, anote o relógio do sistema (`uptime`, `date`) e repita antes de concluir qualquer coisa.
