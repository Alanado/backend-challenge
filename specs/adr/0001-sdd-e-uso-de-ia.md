# ADR-0001 — Spec Driven Development e uso declarado de IA

- **Status:** Aceita · **Data:** 2026-10-27

## Contexto
O desafio avalia raciocínio e decisões justificadas, e haverá apresentação. O prazo é de 3 dias. O código será escrito com Claude Code; arquitetura, regras de negócio e trade-offs são decisões do autor.

## Opções consideradas
1. Codificar direto com IA ("vibe coding"): rápido, mas sem rastreio de decisões e difícil de defender.
2. Não usar IA: mais lento, sem ganho de qualidade garantido.
3. **SDD**: decisões e requisitos escritos antes; a IA implementa tarefas pequenas e verificáveis.

## Decisão
Opção 3. As decisões foram tomadas em rodadas de perguntas (opções, comparação, recomendação e justificativa) e registradas em ADRs; requisitos têm critério de aceite e teste associado; o Claude Code executa **uma tarefa `T-xxx` por vez**, com testes primeiro e um commit por tarefa. O uso de IA é **declarado** no `README.md`: o que a IA fez, o que foi decisão do autor e como foi validado (testes, revisão por milestone, matriz de rastreabilidade).

## Consequências
- (+) Toda decisão é defensável e rastreável; testes derivam dos requisitos.
- (+) Transparência sobre o processo.
- (−) Custo inicial de escrever specs (compensado pelo menor retrabalho).
- (−) Specs podem divergir do código: mudança de decisão exige novo ADR **antes** do código.
