# Changelog

Все значимые изменения в slonk фиксируются в этом файле.

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версионирование — [Semantic Versioning](https://semver.org/lang/ru/).

## [Unreleased]

### Added
- **Phase 2 — MCP server skeleton.** Контейнер `mcp-kanban`
  (TypeScript / Node 22 LTS / pnpm 11) запускается, отвечает на `/health`
  и регистрирует один tool `who_am_i` через MCP-протокол.
  - **Стек:** `@modelcontextprotocol/sdk@^1.29.0` + `fastify@^5.8.5` +
    `zod@^4.4.3` + `pino@^10.3.1`; `vitest@^4.1.6` + `typescript@^5.7.0`
    из dev-deps. `pnpm-lock.yaml` закоммичен.
  - **HTTP-эндпоинты:** `GET /health` (без авторизации) — статус +
    plane_reachable + latency; `GET /mcp/tools` (Bearer) — debug-список
    зарегистрированных tool'ов; `ALL /mcp` (Bearer + `X-Agent-Identity`) —
    основной MCP endpoint через `StreamableHTTPServerTransport`. Сессии
    кэшируются в памяти по `mcp-session-id`.
  - **Auth:** Bearer-токен с constant-time сравнением, X-Agent-Identity
    валидируется по whitelist'у из `src/identity.ts` (6 ролей из docs).
  - **Tool `who_am_i`:** возвращает `{identity, agent_mode, server_version,
    default_workspace, default_project}`. `agent_mode` — из
    `MCP_AGENT_IDENTITY_MODE`.
  - **Логирование:** `pino` JSON в stdout; редактируются `authorization`,
    `x-agent-identity`, `MCP_AUTH_TOKEN`, `PLANE_API_KEY`,
    `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`. Опциональный файловый sink
    через `MCP_LOG_FILE`.
  - **Конфиг:** `src/config.ts` валидирует ENV через zod на старте;
    отказывается стартовать при `MCP_AUTH_TOKEN=change_me` или длине
    < 32 символов. Пустые строки трактуются как «не задано» для optional
    полей (для совместимости с compose `${VAR:-}`).
  - **Plane health probe:** `src/plane-client.ts` пингует корень
    `PLANE_API_BASE_URL` с таймаутом `MCP_PLANE_TIMEOUT_MS`; передаёт
    `X-Api-Key` если задан `PLANE_API_KEY`.
  - **Тесты:** 24 unit-теста (config / auth / who_am_i handler / server
    routing). `pnpm test` зелёный.
  - **Docker:** multi-stage Dockerfile на `node:22.13-alpine`. Прунинг
    devDependencies в production-слое; non-root user `node`; встроенный
    HEALTHCHECK через node-script (без curl/wget). Итоговый образ —
    **176 MB** (< 200 MB по ROADMAP).
  - **Compose:** сервис `mcp-kanban` подключён к `public_net` +
    `internal_net`, публикует `${MCP_SERVER_PORT}:${MCP_SERVER_PORT}`
    (по умолчанию `8787:8787`), depends_on plane-api healthy. Build
    context = `./mcp-kanban`.
- **`make test` / `make build`** — реализованы, заменяют placeholder'ы.
  `make test` выполняет `pnpm install --frozen-lockfile --ignore-scripts`
  + `pnpm test` в `mcp-kanban/`.

### Changed
- **Node 22 LTS** вместо Node 20 LTS — `pnpm@11.1.0` спотыкается о
  `ERR_UNKNOWN_BUILTIN_MODULE` на Node 20.19. Node 22 — текущий Active
  LTS (Node 20 в Maintenance). Обновлены `.nvmrc`, `engines.node` в
  `mcp-kanban/package.json`, [`CONVENTIONS.md` §2](./CONVENTIONS.md#2-стек-mcp-server).

### Added
- **Phase 1 — Plane stack.** `docker-compose.yml` со всем upstream-стеком
  Plane v1.3.0: инфра (`postgres:15.7-alpine`, `valkey/valkey:7.2.11-alpine`,
  `rabbitmq:3.13.6-management-alpine`,
  `minio/minio:RELEASE.2025-09-07T16-13-09Z`) + Plane-сервисы
  (`plane-migrator` one-shot, `plane-api` / `plane-worker` / `plane-beat` из
  единого `makeplane/plane-backend:v1.3.0`, `plane-web` / `plane-admin` /
  `plane-space` / `plane-live`, `plane-proxy` как путевой fan-out). Сети
  `slonk_public_net` (наружу — `plane-proxy:80→${PLANE_HOST_PORT}`) и
  `slonk_internal_net` (всё остальное, изолировано от хоста). Volume'ы
  `slonk_postgres_data` / `slonk_redis_data` / `slonk_rabbitmq_data` /
  `slonk_minio_data` / `slonk_plane_uploads`. Healthcheck'и на все
  длительные сервисы, `condition: service_completed_successfully` для
  `plane-migrator`. Network-aliases (`api`, `web`, `admin`, `space`, `live`,
  `plane-minio`, `plane-db`, `plane-redis`, `plane-mq`) для совместимости с
  bundled Caddyfile внутри `plane-proxy` без модификации образа.
- **`docker-compose.dev.yml` overlay** для отладки — публикует на хост порты
  `postgres:5432`, `redis:6379`, `rabbitmq:5672` + `:15672`,
  `minio:9000` + `:9001`, `plane-api:8000`.
- **`.env.example`** дополнен реальными переменными Plane v1.3.0:
  `PLANE_IMAGE_TAG`, `PLANE_HOST_PORT`, `PLANE_APP_DOMAIN`,
  `PLANE_SITE_ADDRESS`, `PLANE_LIVE_SECRET_KEY`, `PLANE_GUNICORN_WORKERS`,
  `PLANE_API_KEY_RATE_LIMIT`, `PLANE_HARD_DELETE_AFTER_DAYS`,
  `PLANE_FILE_SIZE_LIMIT`, `PLANE_SIGNED_URL_EXPIRATION`, base-URL'ы для
  `app` / `admin` / `space` / `live`, `MINIO_USE`, `MINIO_ENDPOINT_SSL`,
  `RABBITMQ_PORT`. Изменены дефолты: `POSTGRES_HOST=postgres`,
  `RABBITMQ_DEFAULT_VHOST=plane`, `MINIO_BUCKET_PLANE=plane-uploads`,
  `MINIO_BUCKET_MCP=mcp-artifacts`, `PLANE_DEBUG=0` (был `false`).
- **`Makefile`** — реализованы цели Phase 1: `up` (через
  `docker compose up -d --wait`, опц. `dev=1` или `make up-dev` для overlay),
  `down`, `down-v` (с подтверждением, удаляет volume'ы), `logs`, `ps`,
  `smoke` (`docker compose ps` + curl `/`), `config`, `pull`.

### Changed
- **Документация — фактические компоненты Plane v1.3.0.** Скорректированы
  [`ARCHITECTURE.md`](./ARCHITECTURE.md) §3 (распределение по сетям с учётом
  `plane-proxy` как обязательного front-door'а) и §4 (полный список
  сервисов с реальными образами/тэгами/healthcheck'ами),
  [`CONFIGURATION.md`](./CONFIGURATION.md) §2 (Plane/Postgres/RabbitMQ/MinIO
  таблицы с реальными переменными) и §3 (версии образов),
  [`ROADMAP.md`](./ROADMAP.md) Phase 1 (расширенный список деливераблей и
  acceptance-критериев).

### Added
- **Phase 0 — Скелет репозитория.** Корневой `README.md` как точка входа в
  `plane/docs/`, `.gitignore` (секреты, ноды-артефакты, docker-volume'ы,
  бэкапы, SQLite), `.editorconfig` (UTF-8/LF/без trailing ws),
  `.nvmrc` (Node 20 LTS), `.env.example` (стартовый набор переменных с
  заглушками для секретов), пустая директорная структура
  (`mcp-kanban/`, `caddy/`, `prometheus/`, `grafana/`, `loki/`,
  `promtail/`, `backup/`) с `.gitkeep`-маркерами фазы заполнения,
  `Makefile` с целями-заглушками `up`/`down`/`logs`/`test`/`bootstrap` и
  default-целью `help`, которая печатает список доступных команд
  (см. [ROADMAP.md §Phase 0](./ROADMAP.md#phase-0--скелет-репозитория)).
- Документация проекта (`README.md`, `SPEC.md`, `ARCHITECTURE.md`,
  `CONFIGURATION.md`, `ROADMAP.md`, `CONVENTIONS.md`, `CHANGELOG.md`),
  собранная из исходного `BRIEF.md`.
- Зафиксирован выбор стека MCP-сервера: TypeScript на Node.js 20 LTS с
  `@modelcontextprotocol/sdk`, `fastify`, `zod`, `better-sqlite3`, `pino`
  (см. [CONVENTIONS.md §2](./CONVENTIONS.md#2-стек-mcp-server)).
- Зафиксирован поэтапный план реализации (Phase 0…10) с критериями приёмки
  (см. [ROADMAP.md](./ROADMAP.md)).
- Зафиксирован контракт MCP API: 19 инструментов, схемы параметров,
  обработка ошибок, идемпотентность, rate limiting, аудит
  (см. [SPEC.md §6](./SPEC.md#6-mcp-server-api)).
- Зафиксирована схема git-интеграции через машинно-читаемый блок
  `<!-- slonk:meta v1 -->` в описании задачи + SQLite-индекс
  (см. [SPEC.md §5.6](./SPEC.md#56-привязка-к-репозиториям)).
- Зафиксирована модель угроз и базовая модель безопасности
  (см. [ARCHITECTURE.md §9](./ARCHITECTURE.md#9-модель-угроз),
  [SPEC.md §8](./SPEC.md#8-безопасность)).
- Зафиксирована стратегия agent identity с двумя режимами: `per_user`
  (по умолчанию) и `single_bot` (fallback) — параметр
  `MCP_AGENT_IDENTITY_MODE` (см. [SPEC.md §5.5](./SPEC.md#55-agent-identity)).

### Decisions
- **CI:** отказались от GitHub Actions / GitLab CI на этапе v1 — проект
  ведётся локально, без публичного зеркала. Линтеры и тесты запускаются
  вручную через `make` цели. Может быть пересмотрено перед v1.0.0.
- **Branching:** ветка `plane` — основная для разработки v1; merge в `main`
  не делаем до выхода v1.0.0. Фазы из ROADMAP.md идут как
  `feature/phase-<N>-<slug>` от `plane` → squash-merge обратно в `plane`.
- **Plane:** на этапе Phase 1 закрепляем образы Plane на стабильном
  semver-тэге `v1.3.0` (актуальный stable upstream-релиз на момент старта
  фазы) вместо плавающего `latest-stable`. Конкретные digest'ы будут
  закреплены позже.
- **Stack:** TypeScript/Node для MCP — выбран ради зрелого MCP SDK и нативной
  JSON-работы с Plane REST. Альтернативы (Python/Go) отложены.
- **Storage:** локальный SQLite внутри MCP для audit-log, git-refs-индекса
  и identity-маппинга. Никаких внешних БД для MCP — это снижает связность
  с Plane-инфрой.
- **Транспорт MCP:** HTTP+SSE как основной, stdio как опциональный (для
  CLI-агентов и локальной отладки).
- **Меta-блок в описании задачи:** строгий YAML после маркера, идемпотентный
  writer, не разрушает чужой контент при коррупции (ставит `needs-human`).

### Pending
- Выбор лицензии (решается перед v1.0.0).
- Окончательная фиксация digest'ов upstream-образов Plane (Phase 1).
- Webhook-реактор и автоматизация переходов — после v1.0.

---

## История релизов

Релизных версий пока нет. Первая запланированная — `v0.1.0` после завершения
Phase 1 (Plane stack поднимается). См. [ROADMAP.md](./ROADMAP.md).

<!--
Шаблон будущей записи:

## [X.Y.Z] — YYYY-MM-DD

### Added
- …

### Changed
- **BREAKING:** … (если есть)
- …

### Fixed
- …

### Removed
- …

### Security
- …
-->
