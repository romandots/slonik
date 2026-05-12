# syntax=docker/dockerfile:1.7

# ---- builder ----
FROM node:22.13-alpine AS builder

WORKDIR /app

# Build-toolchain для нативных модулей (better-sqlite3 → node-gyp).
# Удаляются после pnpm prune --prod, в runtime-слой не попадают.
RUN apk add --no-cache python3 make g++

# corepack pinning — версия pnpm должна совпадать с package.json
# "packageManager". В node:22.13-alpine corepack ещё содержит устаревший
# набор доверенных ключей и не верифицирует pnpm 11.1.0 — обновляем до
# актуального corepack@latest.
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install -g corepack@latest \
 && corepack enable pnpm \
 && corepack prepare pnpm@11.1.0 --activate

# Lockfile + manifest + workspace (для onlyBuiltDependencies allowlist).
# Native postinstall'ы для better-sqlite3/esbuild разрешены через
# pnpm-workspace.yaml.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Исходники + tsconfig + bootstrap manifest
COPY tsconfig.json ./
COPY src ./src
COPY bootstrap ./bootstrap

# Сборка TS → dist/
RUN pnpm run build

# Прунинг до production-зависимостей (без devDeps).
# Делаем в отдельном --prod store, чтобы не задеть кэш сборки.
RUN pnpm prune --prod


# ---- runtime ----
FROM node:22.13-alpine AS runtime

WORKDIR /app

# Целевые точки монтирования named volume'ов (mcp_data — SQLite-стор,
# mcp_logs — опц. файловый sink). Создаём ДО `USER node` и chown'им на
# node:1000 — Docker при первом монтировании пустого volume копирует
# владельца mount point внутрь volume'а, иначе volume останется root:root
# и better-sqlite3 не сможет открыть файл (SQLITE_CANTOPEN).
RUN mkdir -p /mcp_data /var/log/mcp \
 && chown -R node:node /mcp_data /var/log/mcp

# Не-root пользователь. node:alpine уже содержит user `node`.
USER node

ENV NODE_ENV=production
# MCP_LOG_FILE намеренно не задан — пустое значение фейлит zod-валидацию.
# Если нужен файловый sink, переопределите MCP_LOG_FILE при docker run.

# Готовый билд + production-зависимости + bootstrap-manifest
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/package.json ./package.json
COPY --chown=node:node --from=builder /app/bootstrap ./bootstrap

# Healthcheck — встроенный node-script, нет зависимости от curl/wget
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.MCP_SERVER_PORT||8787)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

EXPOSE 8787

CMD ["node", "dist/server.js"]
