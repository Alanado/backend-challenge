# Relatório W5 — Plataforma e primeira fatia

- Data/hora: 2026-10-28 · branch `wave/w5` (a partir da `main` com a W4, `db4ff95`) · HEAD das tarefas: `1489f81`
- Veredito: **VERDE**

## Tarefas

| Tarefa | Commit | Testes que a fecham (ID → arquivo) | Vermelho → verde |
|---|---|---|---|
| T-050 Logs pino + contexto + redact + `X-Correlation-Id` | `c937c22` | TST-U-12 → `test/unit/platform/log-redaction.test.ts`; parte de TST-I-17 (campos dos logs) → `test/integration/observability.test.ts` | U-12: 7 de 8 falhavam (sem redação, sem contexto); depois 8/8. I-17 (logs): escrito **depois** da implementação, então não houve vermelho inicial; a prova é a mutação "middleware não aplicado", que derruba 5/5 (tabela de dentes) |
| T-051 Métricas e `GET /metrics` | `f17ae11` | TST-I-17 → `test/integration/metrics.test.ts` | esqueleto vazio: 7 de 9 falhavam; depois 9/9 |
| T-054 AuthGuard no-op, `@Public()`, `ProviderIdentityPort` | `1b7285e` | unit `test/unit/platform/auth.test.ts`; integração do `@Public` `test/integration/auth-public.test.ts` | guard esqueleto negando tudo: 3 de 4 falhavam; depois 38/38 (junto da pasta platform) |
| T-030 `CreateWallet` + `GET /wallets/:id` + `ProblemDetailsFilter` | `1489f81` | TST-I-19 → `test/integration/wallet-creation.test.ts` (30 testes), `test/integration/problem-details.test.ts` (503/500), varredura de logs em `observability.test.ts` | 30/30 falhavam (rota inexistente, caso de uso `not implemented`); depois 30/30 |

## Gate (saída real)

| Comando | Exit | Resumo |
|---|---|---|
| `git status` | — | limpo antes do gate |
| `bun install --frozen-lockfile` | 0 | 253 installs, sem mudanças |
| `bun run test:infra:up` | 0 | Postgres 5433 + SQS 4567, filas `unchanged` |
| `bun run typecheck` | 0 | limpo |
| `bun run lint` | 0 | 149 arquivos, sem erros nem warnings |
| `bun run test:unit` | 0 | 393 pass / 0 fail / 0 skip, 3,8 s |
| `bun run test:integration` ×3 | 0 | 252 pass / 0 fail / 0 skip nas três (15,7 s · 15,0 s · 16,7 s) |
| `bun run test:concurrency` | 0 | sem testes (passa vazio até a W7) |
| `grep` de skips (`test`, `src`) | — | nada |

Gate manual (`bun src/main.ts` contra banco novo migrado, `curl`):
- `POST /wallets` → `201`, `X-Correlation-Id: manual-1` devolvido, corpo `{"id":"01a182ef-…","playerId":"0192f298-…","balance":{"amount":"4242.42","currency":"BRL"},"version":1}`.
- `GET /wallets/:id` → `200`, mesmo corpo, `X-Correlation-Id` gerado (UUIDv7).
- `POST` duplicado → `409`, `application/problem+json`, `errorCode: WALLET_ALREADY_EXISTS`, `retryable: false`, `correlationId` = header.
- `GET /wallets/<inexistente>` → `404 WALLET_NOT_FOUND`, problem+json.
- `GET /metrics` → `200`; 10 linhas `# TYPE` com os tipos corretos (content-type conferido no teste I-17: `text/plain; version=0.0.4`).
- Varredura de logs: `grep` pelo `playerId` e por `4242` no log completo do processo → nada. As linhas de acesso trazem só `correlationId`, `walletId`, `channel`, `status`, `durationMs`.

## IDs de teste exigidos × encontrados

`grep -rhoE "TST-[UIC]-[0-9]+" test | sort -u`: TST-I-01 I-02 I-03 I-04 I-14 **I-17** **I-19** · TST-U-01 … U-09 · **U-12** · U-13.
Exigidos pela W5: **TST-U-12 ✔ · TST-I-17 ✔ · TST-I-19 ✔**. Os das ondas anteriores seguem verdes.

## Provas de dentes

| Mutação aplicada (sem commitar) | Teste que falhou | Restaurado |
|---|---|---|
| Tirar `playerId` do `redact`, do scrub e pôr em `LogFields` | TST-U-12: 4 testes (topo, aninhado, case, campos permitidos) | sim (arquivos ainda não commitados; revertido à mão, U-12 8/8) |
| Tirar a métrica `circuit_breaker_open` do registro | TST-I-17: 3 testes (tipos em `/metrics`, "exatamente dez", gauge) | sim (cópia de segurança; 9/9) |
| Remover `@Public()` do `MetricsController` com guard que nega tudo | `auth-public`: `/metrics` deixa de responder 200 | sim (`git checkout`; contagem de `@Public()` = 1) |
| Ignorar o `23505` no repositório de wallet (`if (false)`) | TST-I-19: duplicada (409) e criações simultâneas (viram 500) | sim (30/30) |
| Gravar `OPENING`/ledger/evento fora da transação do insert da wallet | TST-I-19 atomicidade: 2 testes (rollback e "mesmo player cria depois") | sim (30/30). A 1ª tentativa dessa mutação tinha erro de sintaxe (`await` em função não `async`) e não provava nada; refeita corretamente |
| Não aplicar `CorrelationIdMiddleware` | TST-I-17 logs: 5 de 5 | sim (`git checkout`; 5/5) |

## Desvios, decisões, dependências adicionadas

**Dependências** (versões fixas): `pino` 10.4.0 (logger), `nestjs-pino` 5.3.1 (ponte do logger do Nest, peer `pino ^10` / `@nestjs/* ^12` ok), `pino-http` 11.0.0 (peer obrigatório do `nestjs-pino`; o log de acesso automático está **desligado**, `autoLogging: false`). O spike não tinha validado pino; o `nestjs-pino` funcionou sob Bun/Nest 12 sem diferença do esperado.

**Decisões dentro do escopo (o autor pode vetar):**
1. **Valor neutro do label `failure_code`**: `"none"` (constante `NO_FAILURE_CODE`). Só rejeições trazem o código real.
2. **Forma de `ProviderIdentity`**: `{ authenticated: boolean; providerId: string | undefined }`. `NoopProviderIdentity` devolve `{ authenticated: false, providerId: undefined }` e **ignora todo header** (`X-*`, `Authorization`), por serem forjáveis. Porta recebe `IdentityRequest { headers }` (sem tipo de framework).
3. **Colunas `NOT NULL` do `OPENING`**: `round_id = 'opening'`, `game_id = 'system'`, `payload_hash` = hash canônico do próprio `OPENING` (função `payloadHash` do domínio; o teste recalcula e compara). Provider `system`; `external_transaction_id` e `idempotency_key` = `opening:<walletId>`; status `PROCESSED`, `observed_balance` = saldo; inserido já como `PROCESSED` (o trigger de imutabilidade só age em UPDATE/DELETE).
4. **Métricas padrão do Node desligadas** (conforme spike: só `process_*`/heap são confiáveis sob Bun; event loop lag, GC e handles dariam sinal falso). Registro próprio por instância de `PromMetrics`, não o global. Buckets em s: 1 ms … 10 s (13 buckets).
5. **Ordem de locks na criação**: a wallet é inserida pela própria transação (invisível aos outros) antes do insert em `wager_transactions`; nenhuma decisão lê saldo alheio, então não há `FOR UPDATE`. A ordem canônica não foi alterada.
6. **Scrub de logs além do `redact`**: o pino aplica `formatters.log` **antes** dos serializers, e o `redact` não tem curinga recursivo. Por isso há um scrub profundo (chaves proibidas em qualquer nível, sem diferenciar maiúsculas; chaves removidas, não mascaradas). Erros viram `{type, message, stack}`.
7. **Achado durante a T-030 (corrigido na própria tarefa)**: a mensagem de erro do MikroORM traz `- detail: Key (player_id, currency)=(<uuid>, BRL)`, e a mutação do `23505` fez isso aparecer no log. Remover só chaves não bastava; mensagem e stack agora perdem o trecho `detail`/`DETAIL:` e mascaram uuids e valores com 2 casas (`[id]`, `[amount]`). Teste novo em U-12.
8. **Biome**: `javascript.parser.unsafeParameterDecoratorsEnabled: true` em `biome.jsonc` (aprovado por você na sessão: sem a opção o Biome não parseia `@Body`/`@Param`). Nenhuma regra de lint foi desligada. **Sugestão: nota no ADR-0020.**
9. **Filtro `ProblemDetailsFilter`**: `HttpException` do Nest com status ≠ 400 mantém o corpo padrão do Nest (rota desconhecida segue `application/json` com `statusCode`, como exige o `BOOT-03` da W4); `400` do body parser (JSON malformado) vira `VALIDATION_ERROR`. O body parser roda antes do middleware de módulo, então o filtro completa o `X-Correlation-Id` quando ele ainda não existe (função compartilhada `resolveCorrelationId`).
10. **Linhas `app_started`/`app_stopped` continuam JSON simples** (`console.log`): levam `roles` e `port`, que não estão na lista de campos permitidos, e os testes de boot da W4 dependem delas.
11. **Teste da W4 alterado**: `X-10` em `repositories.test.ts` esperava o `23505` cru de `wallets.insert`; o contrato agora é `WalletAlreadyExistsError`. O teste passou a afirmar isso; a constraint em si segue provada em SQL puro (TST-I-02).
12. **Commit da T-051 reescrito (`--amend`)**: comitei com o lint falhando (decorator de parâmetro em `MetricsController`); corrigi (`@Header` com `Registry.PROMETHEUS_CONTENT_TYPE`) e emendei o commit local, ainda não publicado, para manter um commit por tarefa.
13. Detalhes de forma: `GET /wallets/:id` com id que não é uuid → `400 VALIDATION_ERROR` (evita `22P02` virar 500); corpo de `POST /wallets` com campos desconhecidos → `400`.

**Pontos de atenção (não corrigidos, sem decisão minha):**
- Linhas do próprio Nest (boot) saem com a chave `context` (padrão do `nestjs-pino`), fora da lista de campos permitidos. Não carrega dado sensível.
- No `409` de wallet duplicada, o log de acesso traz o `walletId` da tentativa **não persistida** (gerado antes do insert). Inofensivo, mas enganoso para diagnóstico.
- Não há teste automático do `503` vindo de falha real do banco; o mapeamento está coberto com erros reais da aplicação lançados por controllers descartáveis (`problem-details.test.ts`), e a tradução do driver já era coberta na W4.

## Perguntas em aberto / bloqueios

- Nenhum bloqueio. Uma pergunta feita e respondida durante a onda (Biome, item 8).

## Pré-condições da próxima onda verificadas

- `typecheck`, `lint`, `test:unit` (393) e `test:integration` (252, 3×) verdes; `bun src/main.ts` sobe, atende HTTP e para com `SIGTERM`.
- Disponível para a W6: `MetricsPort`/`NoopMetrics`, `AppLogger`/`LogContext` (setters de `transactionId`, `messageId`, `providerId`), `CLOCK`/`ID_GENERATOR` no módulo global, `ProblemDetailsFilter` (a T-033 acrescenta os demais `errorCode`), `CreateWallet` para montar wallets nos testes via HTTP.
