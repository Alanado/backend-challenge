# ADR-0003 — Arquitetura hexagonal enxuta e topologia de processos

- **Status:** Aceita · **Data:** 2026-10-27

## Contexto
O enunciado avalia "invariantes encapsuladas em classes, boundaries, portas, simplicidade" e exige correção com múltiplas instâncias.

## Opções consideradas
**Estilo:** (A) hexagonal enxuta [escolhida]; (B) DDD completo com CQRS e event sourcing — peças demais para 3 dias; (C) camadas simples controller/service/repository — fraco em invariantes e portas.
**Topologia:** (A) uma imagem, cada instância faz todos os papéis, com flags [escolhida]; (B) processos separados por papel — mais configuração e RAM; (C) monorepo com apps separados — excesso.

## Decisão
- Módulos `wallet`, `wagering`, `messaging`, `platform`, cada um com `domain/`, `application/` (casos de uso e portas) e `infrastructure/` (adaptadores); `shared/` com `Money`, erros, relógio e config.
- `domain` puro. Sem CQRS nem event sourcing.
- **Uma imagem**; HTTP, consumidor SQS, publisher da outbox e worker de referências rodam em toda instância, ligados por `ENABLE_*`. "3 instâncias" e "dois publishers" são apenas réplicas.

## Consequências
- (+) Simples de explicar e de testar; o multi-instância é exercitado de verdade.
- (+) Portas permitem trocar SQS/ORM e testar sem acoplar.
- (−) Sem escala independente por papel (documentado como evolução).
