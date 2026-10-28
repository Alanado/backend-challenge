# Imagem única da aplicação: os três serviços app1..3 e o `migrate` do docker-compose.yml a usam.
# Bun fixado por tag e digest (o mesmo critério das imagens de infra). Não há etapa de build: o Bun
# executa o TypeScript direto, então só as dependências de produção e o código entram na imagem.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

WORKDIR /app
ENV NODE_ENV=production

# `--ignore-scripts`: o `prepare` do projeto instala hooks do git, que não existem na imagem.
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY src ./src
COPY scripts ./scripts

# Usuário sem privilégios que a imagem do Bun já traz.
USER bun
# A porta vem de PORT (3001-3003 no Compose), por isso não há EXPOSE.
CMD ["bun", "src/main.ts"]
