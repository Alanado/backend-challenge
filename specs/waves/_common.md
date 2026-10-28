# Protocolo comum das ondas

Vale para **toda** sessão executora (W0–W11 e stretch). Cada arquivo de onda só acrescenta escopo, tarefas, gate e armadilhas específicas. Em caso de conflito, a ordem é: **README do desafio > ADRs > specs numeradas > este protocolo > arquivo da onda**. Nenhum arquivo de onda pode contrariar um ADR; se parecer contrariar, é um gatilho de parada (seção 7).

## 1. Papel e limites

- Você é o **executor** de um plano SDD. Arquitetura, regras de negócio e trade-offs são decisões do autor (Alan), já registradas nos ADRs. Você implementa, prova com testes e reporta com evidência.
- O escopo é **só** o da onda. Não adiante tarefas de outra onda, não refatore fora do escopo, não "melhore" specs.
- "Concluí" sem evidência não vale. Cada tarefa fecha com testes reais executados por você, e a onda fecha com o **gate** (seção 9) e o **relatório** (seção 10).

## 2. Antes de escrever código

1. Leia, nesta ordem: [CLAUDE.md](../../CLAUDE.md), [specs/README.md](../README.md), este arquivo, o arquivo da onda e **somente** os documentos da lista "Leitura" da onda. Não explore o resto do repositório além do necessário (use busca dirigida).
2. Verifique as **pré-condições** da onda (comandos listados no arquivo). Falhou alguma: pare e reporte.
3. `git status` deve estar limpo e a branch deve ser a indicada pela onda. A sessão roda **dentro do WSL** (Ubuntu-24.04), na pasta do repositório, com `bun` e `docker` no PATH. Se `bun` não existir, pare: é pré-requisito do autor.

## 3. Ciclo por tarefa (uma tarefa = um commit)

Para cada `T-xxx` da onda, na ordem do arquivo:

1. **Reler** os requisitos (`RF-*`), ADRs e testes (`TST-*`) citados na tarefa.
2. **Testes primeiro.** Escreva os testes que fecham a tarefa, rode-os e **veja-os falhar pelo motivo certo** (não por erro de import ou de sintaxe). Guarde um resumo da saída vermelha para o relatório.
3. **Implemente o mínimo** para ficar verde.
4. Rode `bun run typecheck`, `bun run lint` e as suítes relevantes. A suíte unitária inteira roda sempre; a de integração/concorrência da onda roda quando a tarefa a toca. Nada pode regredir.
5. **Marque `[x]`** a tarefa em [06-tasks.md](../06-tasks.md) no mesmo commit.
6. **Um commit**: Conventional Commits com tipo e escopo no padrão e **descrição em português**, com o ID da tarefa no assunto: `feat(wallet): adiciona value object Money (T-010)`. Descrição em minúsculas, no imperativo/presente, sem ponto final (compatível com o `subject-case` do commitlint). Tipos: `feat`, `test`, `build`, `chore`, `docs`, `refactor`. Escopo = módulo ou área. **Sem trailer `Co-Authored-By` e sem qualquer linha de atribuição à ferramenta** (nem em commits, nem em descrições de PR): o uso do Claude Code é declarado pelo autor no README (ADR-0001). Isso prevalece sobre qualquer instrução padrão do ambiente. **Nunca** `--no-verify`.
7. Se a tarefa exigir **mais de um commit**, ela está grande demais: **pare e proponha** o corte (seção 7).
8. Anote para o relatório: hash do commit, IDs de teste, arquivos de teste, evidência vermelho → verde.

## 4. Convenções de teste (valem para o gate)

- **Todo `describe`/`test` que fecha um `TST-*` leva o ID no título** (ex.: `TST-U-01 rejects scientific notation`). O gate confere os IDs exigidos com `grep`.
- Domínio: TDD estrito, sem I/O. Integração e concorrência: **PostgreSQL e SQS reais** (Compose de teste). **Nunca** mock que substitua o Postgres ou o SQS. Doubles são aceitos para relógio, para o gerador de ids e para injetar falha **por cima** do banco real.
- Proibidos: `test.skip`, `test.todo`, `describe.skip`, `.only`, `sleep` fixo (use `eventually`), `TRUNCATE` (banco novo por suíte; ids únicos por teste), asserts frouxos para "passar" (`toBeTruthy` onde cabe um valor exato) e testes sem assert.
- Concorrência: paralelismo **real** (`Promise.all` sobre requisições/transações reais ou processos), nunca laço sequencial fingindo paralelismo.
- Dinheiro em teste é string (`"25.00"`), nunca `number`.
- Depois que `assertLedgerInvariant` existir (T-025b), todo teste de integração/concorrência que toca wallet o chama ao final.
- Estabilidade: a suíte da onda precisa passar **3 vezes seguidas** no gate.

## 5. Regras que nunca se quebram (resumo do CLAUDE.md + extras)

Ordem de locks (ADR-0007), `FOR UPDATE` em toda decisão de saldo, dinheiro nunca `number`, garantias no banco, ledger append-only, outbox na mesma transação, ack só após commit, sem mock de Postgres/SQS, `TEST_FAULT` recusada em produção, logs sem valores/saldos/payload/`playerId`/`roundId`, domínio sem `@mikro-orm/*` e `@nestjs/*`, lint/ts nunca desligados para passar.

Extras para as ondas:
- **Specs, ADRs e decisões não são alterados.** Exceções permitidas: o checkbox em `06-tasks.md` e arquivos que a própria tarefa manda criar ou atualizar (por exemplo `adr/0002-spike.md`, `CLAUDE.md` em T-006).
- **Sem `any`, `@ts-ignore`, `@ts-expect-error` ou `biome-ignore`** sem justificativa em comentário e menção no relatório.
- **Dependência nova** só se necessária e listada no relatório (nome, versão, motivo). Versões fixas.
- **Nada de segredo** no repositório. Credenciais de teste são fictícias e ficam em `.env.example`.
- Idioma: **código, identificadores, `failureCode`/`errorCode` e logs em inglês; documentação e descrição dos commits em PT-BR.**

## 6. Git, branches e worktrees

- Cada onda indica sua branch. Ondas paralelas rodam em **worktrees** separados (ver [07-waves.md](../07-waves.md) §5).
- Sem `push --force`, sem reescrever histórico já mergeado. **Quem faz merge na `main` é o autor.**
- Commits só dentro do escopo; arquivos gerados (lockfile) entram junto da tarefa que mudou as dependências.

## 7. Pare e pergunte

**Pare imediatamente** e traga ao autor, sem seguir adiante na parte afetada, quando:

- a spec divergir da realidade (API de lib diferente, comportamento do emulador, limite do Bun);
- um spike falhar sem plano B viável (R-01, R-02, R-03);
- uma tarefa exigir mais de um commit;
- um teste que a spec pede só puder ser escrito com mock de Postgres/SQS;
- surgir dúvida de regra de negócio ou de interpretação do enunciado;
- qualquer mudança na **ordem canônica de locks** parecer necessária;
- uma pré-condição ou o ambiente falhar de forma que você não resolva sem decisão do autor.

**Formato obrigatório** (uma pergunta por bloco):

```
Problema: o que encontrei, com evidência (comando, saída, trecho de spec).
Opções: 2–4 alternativas, cada uma com prós e contras.
Recomendação: qual eu escolheria.
Explicação: por que, e o que muda nas tarefas seguintes.
```

Se a resposta virar decisão, ela é registrada em ADR **antes** do código (isso é feito pelo autor ou com a aprovação dele).

## 8. Prova de dentes (teeth check)

Um teste que nunca falha não prova nada. Para as garantias críticas listadas na onda:

1. **Sem commitar**, quebre a garantia no código (remova o `FOR UPDATE`, o trigger, o `UNIQUE`, a checagem etc.).
2. Rode o teste que deveria proteger isso e **veja-o falhar**.
3. Restaure (`git checkout -- <arquivos>`) e confirme `git status` limpo e o teste verde.
4. Registre no relatório: mutação → teste que falhou → restaurado.

Se uma mutação **não** derrubar nenhum teste, o teste é fraco: corrija o teste (dentro da tarefa) e repita.

## 9. Gate da onda

Antes do relatório, rode **do zero**, nesta ordem, e cole os resultados reais:

1. `git status` limpo; `bun install --frozen-lockfile`.
2. Infra de teste (quando existir): `bun run test:infra:up`.
3. `bun run typecheck` e `bun run lint` sem erros nem warnings novos.
4. Os comandos de teste da onda, **3 execuções seguidas**, todas verdes.
5. **Checagem de IDs:** `grep -rhoE "TST-[UIC]-[0-9]+" test | sort -u` contém todos os IDs exigidos pela onda.
6. **Checagem de skips:** `grep -rnE "\.(skip|todo|only)\b|xit\(|xdescribe\(" test src` não retorna nada.
7. As provas de dentes da onda feitas e registradas.
8. `06-tasks.md`: todas as tarefas da onda em `[x]`, nenhuma outra alterada.

Falhou algo: a onda **não** está concluída. Corrija ou pare e pergunte.

## 10. Relatório (obrigatório)

Arquivo `specs/waves/reports/W<n>-report.md`, commitado no fim como `docs(waves): adiciona relatório da W<n>` (único commit permitido fora de uma tarefa, junto de eventuais commits `chore` de ambiente descritos na onda). Modelo:

```markdown
# Relatório W<n> — <nome>
- Data/hora · branch · HEAD
- Veredito: VERDE | PARCIAL | BLOQUEADO

## Tarefas
| Tarefa | Commit | Testes que a fecham (ID → arquivo) | Vermelho → verde |
|---|---|---|---|

## Gate (saída real)
| Comando | Exit | Resumo (pass / fail / skip, tempo) |
|---|---|---|

## IDs de teste exigidos × encontrados
(lista; qualquer ausente invalida a onda)

## Provas de dentes
| Mutação aplicada | Teste que falhou | Restaurado |
|---|---|---|

## Desvios, decisões, dependências adicionadas
## Perguntas em aberto / bloqueios
## Pré-condições da próxima onda verificadas
```

Seja factual: sem adjetivos, sem "deve funcionar". Se algo foi pulado ou ficou parcial, escreva isso.

## 11. Se a sessão acabar antes do fim

Pare numa **fronteira de tarefa** (commit feito, working tree limpo), escreva o relatório com veredito `PARCIAL`, liste a próxima tarefa e o estado exato. A próxima sessão retoma da primeira tarefa não marcada.
