# Specs — Distributed Wagering Processor

> Estado: **decisões fechadas em 2026-10-27** (rodadas 1 a 5 de planejamento). Implementação: não iniciada.
> Fonte da verdade do enunciado: [`../README.md`](../README.md). Em caso de conflito, a ordem de precedência é:
> **README do desafio > ADRs > specs numeradas > código**.

## Como ler

| Arquivo | Para que serve |
|---|---|
| [00-overview.md](00-overview.md) | Escopo, invariantes globais, glossário, premissas assumidas, riscos e cronograma |
| [01-requirements.md](01-requirements.md) | Requisitos (RF/RNF) com critério de aceite, origem e teste que os prova |
| [02-design.md](02-design.md) | Arquitetura, domínio, máquina de estados, schema SQL, algoritmo transacional, ordem de locks |
| [03-messaging.md](03-messaging.md) | Outbox, inbox, consumidor SQS, DLQ, worker de referências, shutdown, circuit breaker, eventos |
| [04-api.md](04-api.md) | Contratos HTTP, mapeamento de status, catálogos `errorCode` e `failureCode`, idempotência |
| [05-test-plan.md](05-test-plan.md) | Cenários de teste (TST-*), infraestrutura de teste, helpers |
| [06-tasks.md](06-tasks.md) | Milestones e tarefas T-xxx, rastreáveis a requisitos e testes |
| [07-waves.md](07-waves.md) | Plano de execução: tarefas agrupadas em ondas (sessões), calendário, gates, prompts em [waves/](waves/) |
| [study-guide.md](study-guide.md) | Guia de estudo: como defender cada decisão na apresentação |
| [adr/](adr/) | Uma decisão por arquivo (formato MADR enxuto) |

## Convenções

- **IDs:** `RF-<área>-nn` (requisito funcional), `RNF-nn` (não funcional), `ADR-nnnn`, `T-nnn` (tarefa), `TST-<U|I|C>-nn` (teste unitário, integração, concorrência), `R-nn` (risco).
- **Idioma:** documentação e descrição dos commits em PT-BR; código, identificadores, `failureCode`/`errorCode` e logs em inglês.
- **Commits:** Conventional Commits (tipo e escopo no padrão; descrição em português), uma tarefa `T-xxx` por commit. Se uma tarefa exige mais de um commit, ela está grande demais e deve ser quebrada.
- **Mudança de decisão:** nenhuma decisão, spec ou a ordem de locks é alterada sem pedir confirmação ao autor. Mudou? Atualize o ADR (novo ADR que substitui o anterior) e a spec afetada **antes** do código.

## Ciclo de trabalho (SDD)

1. Escolher a próxima tarefa em `06-tasks.md` (dependências satisfeitas).
2. Reler os requisitos e ADRs citados na tarefa.
3. Escrever os testes primeiro (domínio em TDD; integração/concorrência conforme `05-test-plan.md`).
4. Implementar o mínimo para passar; rodar `bun run lint` e a suíte relevante.
5. Commit (`feat(wagering): …`, `test(…)`, `docs(…)`), marcar a tarefa como concluída.
6. Ao fim de cada milestone: revisão do autor com a matriz de rastreabilidade (requisito → tarefa → teste).
