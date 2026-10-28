# ADR-0017 — Autenticação: não implementada, com ponto de extensão

- **Status:** Aceita · **Data:** 2026-10-27 · **Relacionados:** RF-AUT-01 · **Stretch:** S-03

## Contexto
Autenticação **não vale pontos** (§2) e não pode competir com correção financeira. O enunciado aceita não implementar, desde que se documente o desenho e se deixe o ponto de extensão no código. Se implementada, deve ser por IdP externo (Keycloak/Zitadel), nunca artesanal.

## Opções
A. Não implementar: `AuthGuard` no-op + `ProviderIdentityPort` + desenho documentado. **(escolhida)**
B. Keycloak (JWT via JWKS): mais próximo de produção; container pesado (centenas de MB a ~1 GB) com 8 GB de RAM e configuração de realm.
C. Zitadel: mais leve, mesmo custo de tempo.

## Decisão
**A.** `AuthGuard` global no-op e `ProviderIdentityPort` (`resolveProvider(request): ProviderIdentity`), com implementação `NoopProviderIdentity`. Health e `/metrics` abertos; mensagens da fila são canal interno confiável, mas a identidade do provedor no payload continua sujeita às validações de domínio.

**Desenho descrito no `ARCHITECTURE.md`:** OIDC com client credentials; um client por provedor; o `azp` (ou claim customizada) mapeia para `providerId`; o guard compara com o `providerId` do corpo (403 se divergir); validação por JWKS com cache.

Se sobrar tempo: S-03, implementando a porta com Keycloak/Zitadel.

## Consequências
- (+) Tempo e RAM preservados para o que pontua. (−) Sem integração real; declarado.
