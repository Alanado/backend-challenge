# WS — Ondas de stretch (opcionais)

**Só começam com W0–W11 verdes** (idealmente depois de W11; com W10 verde e tempo sobrando, pode-se antecipar S-01). Ordem de prioridade fixada pela spec ([00-overview §2](../00-overview.md)): **S-01 → S-02 → S-03 → S-04 → S-05 → S-06**. Cada item é uma sessão independente, com sua branch (`wave/ws-0N`).

## Regras comuns a todo stretch

1. Vale integralmente o protocolo de [_common.md](_common.md).
2. **Passo 0 é sempre uma rodada de decisão com o autor, antes de qualquer código.** Todo item do stretch toca uma decisão que não está fechada nos ADRs. A sessão abre dizendo o que pretende, traz as opções no formato **Problema / Opções / Recomendação / Explicação**, e **só depois da resposta** escreve o ADR (novo, que referencia o que complementa ou substitui) e as specs afetadas, **antes** do código ([specs/README.md](../README.md), "Mudança de decisão").
3. **Nada do que já está verde pode regredir:** a suíte completa (`bun run test`, 3×) continua verde ao fim, e nenhuma garantia existente é enfraquecida.
4. Um commit por tarefa; se estourar, pare e proponha o corte. Relatório `specs/waves/reports/WS-0N-report.md` no mesmo modelo.
5. Se o tempo acabar no meio, **não deixe a `main` quebrada**: o trabalho incompleto fica na branch.
6. Documente o resultado em `README.md`/`ARCHITECTURE.md` (PT-BR) na própria onda.

## Prompt-base (preencha `<S-0N>` e `<NOME>`)

```text
Você é a sessão executora do stretch <S-0N> — <NOME> do desafio Distributed Wagering Processor.
Trabalhe dentro do WSL, na pasta do repositório, branch wave/ws-0N, criada a partir da main (W0–W11 verdes).
Leia nesta ordem: CLAUDE.md, specs/README.md, specs/waves/_common.md e a seção <S-0N> de specs/waves/WS-stretch.md, mais os documentos que ela lista.
PASSO 0 (obrigatório): ANTES de escrever código, traga ao autor as decisões em aberto no formato Problema/Opções/Recomendação/Explicação e aguarde a resposta. Depois da aprovação, escreva o ADR e atualize as specs afetadas, e só então implemente: testes primeiro, um commit por tarefa, protocolo de _common.md.
A suíte completa existente não pode regredir. Ao final: gate, specs/waves/reports/WS-0N-report.md e veredito com evidência.
```

---

## S-01 — `bun run test:load`

**Valor:** diferencial citado no enunciado (§14: "teste de carga também conta como diferencial"). Qualidade do experimento e honestidade da análise pesam mais que o número bruto; não há meta de RPS.

**Leitura:** README do desafio §14 (último parágrafo) · [ADR-0006](../adr/0006-concorrencia-lock-pessimista.md) (alternativas A e C) · [ADR-0014](../adr/0014-outbox-e-eventos.md) · [04-api.md](../04-api.md) §7 (métricas) · [05-test-plan.md](../05-test-plan.md) §1 · Compose completo da W10.

**Decisões do passo 0:** ferramenta (script Bun próprio × k6 em container — atenção à RAM de 8 GB); perfil dos cenários (wallets distintas, wallet quente, mix com duplicatas/reversões, via HTTP e via SQS); duração e rampa; **como comparar a estratégia A (pessimista) com a C (`UPDATE` condicionado)** a 50 concorrentes sem tocar na implementação de produção (por exemplo, uma flag de experimento apenas no ambiente de carga). Mudar a estratégia padrão **não** está em jogo.

**Entregas:** `bun run test:load`; relatório em PT-BR com **ambiente** (CPU, RAM, versões, instâncias, pool), **metodologia**, **throughput, p50/p95/p99, taxa de erro, conflitos de concorrência (`lock_conflicts_total`), outbox lag**, comparação A × C com análise honesta (limitações, ruído, o que não se pode concluir); invariante final (`assertLedgerInvariant`) verificada **após** a carga.

**Gate:** o comando roda do zero e termina com exit 0; o relatório contém todos os campos acima; a invariante do ledger vale em todas as wallets tocadas; nenhum teste anterior regride.

## S-02 — Constraint trigger de consistência saldo × ledger

**Valor:** fecha, no banco, a garantia "saldo = último `balance_after`" que hoje é coberta por reconciliação e testes ([ADR-0009](../adr/0009-ledger-imutavel.md)).

**Leitura:** [ADR-0009](../adr/0009-ledger-imutavel.md) · [ADR-0016](../adr/0016-reconciliacao.md) · [02-design.md](../02-design.md) §4 · [05-test-plan.md](../05-test-plan.md) TST-I-01..I-03, I-14.

**Decisões do passo 0:** semântica exata da checagem (último `balance_after` × soma do ledger; custo O(1) × O(n)); tratamento da wallet nascida zerada; `DEFERRABLE INITIALLY DEFERRED` e a interação com o `down`; **impacto no TST-I-14**, que hoje induz divergência com `UPDATE wallets SET balance` direto — esse `UPDATE` passaria a falhar no commit, então o teste precisa de uma estratégia explícita (desabilitar o trigger só no teste, ou outra); impacto de desempenho na wallet quente.

**Entregas:** ADR novo (complementa o 0009), migration 4 reversível, testes: commit inconsistente é rejeitado pelo banco; todos os fluxos legítimos (todas as ondas) seguem passando; o `down` funciona com dados; I-14 adaptado sem perder a cobertura do que a reconciliação detecta.

**Gate:** suíte completa verde 3×; prova de dentes: remover o trigger → o novo teste fica vermelho.

## S-03 — IdP real atrás do `ProviderIdentityPort`

**Valor:** autenticação real por Identity Provider externo (Keycloak/Zitadel); **não vale pontos** (README §2), então só depois dos demais.

**Leitura:** [ADR-0017](../adr/0017-autenticacao.md) · README do desafio §2 · código do `AuthGuard`/`ProviderIdentityPort` (T-054).

**Decisões do passo 0:** Keycloak × Zitadel (RAM de 8 GB: medir); fluxo (OIDC client credentials, um client por provedor); claim que mapeia para `providerId` (`azp` ou customizada) e a regra do guard (403 se divergir do corpo); validação por JWKS com cache; o que continua aberto (`/health/*`, `/metrics`) e o canal SQS (confiável).

**Entregas:** adaptador real da porta, Compose com o IdP e realm importável, testes com **token real** emitido pelo IdP (válido, expirado, `providerId` divergente, ausente), README/ARCHITECTURE atualizados. O `NoopProviderIdentity` continua disponível por configuração (a suíte existente não precisa de IdP).

**Gate:** testes de auth verdes com IdP real; suíte existente verde sem IdP; RAM do Compose reportada.

## S-04 — Swagger/OpenAPI a partir dos schemas Zod

**Leitura:** [ADR-0020](../adr/0020-ferramentas-e-validacao.md) · [04-api.md](../04-api.md) · schemas Zod exportados (T-033).

**Decisões do passo 0:** biblioteca de geração a partir de Zod (e compatibilidade com o Nest sob Bun); onde servir (`/docs`, JSON em `/openapi.json`) e se fica fora do guard; como representar problem+json, os 4 status de resultado e o header `Idempotency-Key`.

**Entregas:** documento OpenAPI gerado **do mesmo schema usado na validação** (sem duplicar contrato), `/docs`, e um **teste de contrato**: as respostas reais da API validam contra o OpenAPI gerado (para os status 201/200/202/422/400/409/404/503).

**Gate:** teste de contrato verde; suíte existente verde; prova de dentes: alterar um campo do schema muda o documento e quebra o teste de contrato quando a API não acompanha.

## S-05 — Partidas dobradas (double-entry)

**Valor:** diferencial opcional (README §6.4). **Maior risco do stretch:** toca schema, ledger, reconciliação e a maioria dos testes.

**Leitura:** README do desafio §6.4 · [ADR-0009](../adr/0009-ledger-imutavel.md) · [ADR-0016](../adr/0016-reconciliacao.md) · [02-design.md](../02-design.md) §2, §4 · [01-requirements.md](../01-requirements.md) RF-LED-*.

**Decisões do passo 0 (todas do autor, antes de qualquer código):** modelo de contas (conta da wallet × conta de contrapartida do provedor/casa); como as partidas se relacionam com a regra "no máximo um lançamento por wallet e transação"; migração do schema (colunas novas × tabela de partidas); impacto na reconciliação e no `assertLedgerInvariant`; compatibilidade com a imutabilidade e com o cursor de paginação; **plano de retorno** se o risco passar do aceitável. Se a conclusão for "não cabe sem desfigurar as garantias", a sessão recomenda **não fazer** e documenta a evolução em `ARCHITECTURE.md`.

**Gate:** invariantes originais intactas (todas as ondas verdes), nova invariante "Σ débitos = Σ créditos" verificada pela reconciliação, e prova de dentes.

## S-06 — OpenTelemetry

**Leitura:** [ADR-0018](../adr/0018-observabilidade.md) · README do desafio §12 · código de logs/métricas/contexto (T-050, T-051).

**Decisões do passo 0:** SDK e exportador (OTLP para um coletor em container × console); o que instrumentar (HTTP, SQS, publisher, worker, transações SQL); **propagação do contexto pelo outbox** (`traceparent` no envelope do evento sem alterar o contrato versionado) e pelo SQS; custo de RAM.

**Entregas:** spans nos fluxos principais com `correlationId` como atributo, propagação HTTP → outbox → evento e SQS → caso de uso, teste de integração que valida a árvore de spans num exportador em memória **sem** substituir Postgres/SQS, ARCHITECTURE atualizado.

**Gate:** testes de spans verdes; suíte existente verde; nenhum dado proibido (valores, saldos, `playerId`, `roundId`) em atributos de span (teste de varredura).
