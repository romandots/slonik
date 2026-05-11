# syntax=docker/dockerfile:1.7

# ---- builder ----
FROM node:22.13-alpine AS builder

WORKDIR /app

# corepack pinning — версия pnpm должна совпадать с package.json
# "packageManager". В node:22.13-alpine corepack ещё содержит устаревший
# набор доверенных ключей и не верифицирует pnpm 11.1.0 — обновляем до
# актуального corepack@latest.
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install -g corepack@latest \
 && corepack enable pnpm \
 && corepack prepare pnpm@11.1.0 --activate

# Сначала только lockfile + manifest — кешируем зависимости отдельно.
# --ignore-scripts: postinstall-скрипты не нужны для prod-сборки. esbuild
# (через vitest) использует pre-built бинари per-platform, его postinstall
# скрипт мы пропускаем — это devDependency, в финальный runtime-слой не
# попадает после pnpm prune --prod ниже.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

# Исходники + tsconfig (vitest.config.ts не копируем — не нужно для сборки)
COPY tsconfig.json ./
COPY src ./src

# Сборка TS → dist/
RUN pnpm run build

# Прунинг до production-зависимостей (без devDeps).
# Делаем в отдельном --prod store, чтобы не задеть кэш сборки.
RUN pnpm prune --prod


# ---- runtime ----
FROM node:22.13-alpine AS runtime

WORKDIR /app

# Не-root пользователь. node:alpine уже содержит user `node`.
USER node

ENV NODE_ENV=production
# MCP_LOG_FILE намеренно не задан — пустое значение фейлит zod-валидацию.
# Если нужен файловый sink, переопределите MCP_LOG_FILE при docker run.

# Готовый билд + production-зависимости
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/package.json ./package.json

# Healthcheck — встроенный node-script, нет зависимости от curl/wget
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.MCP_SERVER_PORT||8787)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

EXPOSE 8787

CMD ["node", "dist/server.js"]
