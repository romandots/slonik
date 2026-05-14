# CLAUDE.md — инструкции для Claude Code в проекте slonk

## Проект

**slonk** — self-hosted Kanban для LLM-агентов на базе Plane v1.3.0 + собственного
MCP-сервера (`mcp-kanban`). Один локальный `docker compose up -d` поднимает весь
стек: Plane (web/admin/space/live/api/worker/beat/migrator + proxy), инфру
(Postgres/Valkey/RabbitMQ/MinIO) и MCP, через который агенты работают с задачами.

Single-tenant, single-node, без HA. Все секреты — в `.env`, в репозиторий не
коммитятся.

Инструкции, которые находятся в `docs/claude/` не предназначены для исполнения данным агентом. 
Это часть документации проекта.

## Полная документация

Источник правды по архитектуре, конфигурации и контрактам — каталог
[`docs/`](./docs/). Перед любой нетривиальной задачей читать как
минимум [SPEC.md](./docs/SPEC.md) и
[CONVENTIONS.md](./docs/CONVENTIONS.md).

| Документ | Когда читать |
|---|---|
| [README](./docs/README.md) | Оглавление каталога `docs/` |
| [USER_GUIDE](./docs/USER_GUIDE.md) | Полный пошаговый сценарий установки, настройки и обучения агентов |
| [SPEC](./docs/SPEC.md) | Контракт MCP API, workflow, ошибки, безопасность |
| [ARCHITECTURE](./docs/ARCHITECTURE.md) | Сети, контейнеры, потоки данных, угрозы |
| [CONFIGURATION](./docs/CONFIGURATION.md) | `.env`, compose, bootstrap, версии образов |
| [ROADMAP](./docs/ROADMAP.md) | План фаз и acceptance-критерии |
| [CONVENTIONS](./docs/CONVENTIONS.md) | Кодстайл, naming, git, тесты |
| [CHANGELOG](./docs/CHANGELOG.md) | История изменений (Keep a Changelog) |

## Структура проекта

```text
slonk/
├── docker-compose.yml           # базовый стек Plane v1.3.0 + mcp-kanban
├── docker-compose.dev.yml       # overlay: публикация портов БД/MinIO/API на хост
├── .env / .env.example          # конфиг (.env не коммитится)
├── Makefile                     # up/down/logs/smoke/test/build/bootstrap
├── docs/                        # вся проектная документация
│   └── claude/                  # стартер-кит для агентов: CLAUDE.md + skills/slonk-*/ + .mcp.json (примеры)
├── mcp-kanban/                  # MCP-сервер (TypeScript, Node 22 LTS, pnpm 11)
│   ├── Dockerfile               # multi-stage, итог < 200 MB
│   ├── package.json             # @modelcontextprotocol/sdk, fastify, pino, zod, better-sqlite3
│   ├── bootstrap/manifest.yaml  # workspace/projects/states/labels/identities
│   └── src/
│       ├── server.ts            # Fastify + MCP StreamableHTTP, dispatch (run|bootstrap)
│       ├── config.ts            # zod-валидация ENV
│       ├── auth.ts              # Bearer + X-Agent-Identity
│       ├── identity.ts          # рантайм-реестр agent-identity (источник — manifest/store)
│       ├── plane-client.ts      # обёртка Plane REST + retry/backoff
│       ├── meta-block.ts        # парсер <!-- slonk:meta v1 --> в description
│       ├── cache.ts             # TTL=10s in-memory кэш для read-tools
│       ├── audit.ts             # SQLite audit_log + claim_lock
│       ├── rate-limit.ts        # token-bucket (global + per-identity)
│       ├── bootstrap/           # CLI + runner + identity store
│       └── tools/
│           ├── registry.ts      # регистрация всех tool'ов в McpServer
│           ├── context.ts       # ToolContext (передаётся в handler'ы)
│           └── <tool-name>/{schema.ts, handler.ts, handler.test.ts}
├── caddy/                       # Caddyfile для внешнего TLS (Phase 7)
├── prometheus/, grafana/, loki/, promtail/  # observability (Phase 8)
└── backup/                      # Dockerfile + entrypoint.sh + run.sh (Phase 9)
```

## Команды

```bash
# Поднять стек (без публикации БД-портов на хост)
make up

# Поднять стек + dev-overlay (публикуется postgres/redis/rabbitmq/minio/plane-api)
make up-dev          # эквивалент: make up dev=1

# Поднять стек + proxy-overlay (внешний Caddy TLS на 80/443, базовые порты скрыты)
make up-proxy        # эквивалент: make up proxy=1

# Поднять стек + observability-overlay (Prometheus/Grafana/Loki/Promtail)
make up-obs          # эквивалент: make up obs=1

# Поднять стек + backup-overlay (cron-bound pg_dump + minio mirror + mcp_data tar)
make up-backup       # эквивалент: make up backup=1
make backup-now      # разовый прогон бэкапа (run-once entrypoint)

make down            # остановить, volume'ы сохраняются
make down-v          # ВНИМАНИЕ: удаляет volume'ы, нужно явное "yes"
make logs            # tail -f логов всех сервисов
make ps              # docker compose ps
make smoke           # ps + curl Plane UI
make config          # вывести merged compose-config (для отладки)
make pull            # обновить pinned-образы

# MCP server (TypeScript)
make test            # cd mcp-kanban && pnpm install --frozen-lockfile && pnpm test
make build           # docker compose build mcp-kanban

# Bootstrap (после первого UI-логина и заполнения PLANE_API_KEY)
make bootstrap       # docker compose run --rm mcp-kanban node dist/server.js bootstrap
```

В `mcp-kanban/`:

```bash
pnpm install --frozen-lockfile
pnpm test            # vitest run (unit)
pnpm typecheck       # tsc --noEmit
pnpm lint            # eslint src
pnpm build           # tsc → dist/
pnpm dev             # tsx watch src/server.ts (локальная разработка без Docker)
```

## Текущее состояние (фазы)

**Все Phase 0–10 закрыты — v1.0.0 (2026-05-12).** Подробно — в
[CHANGELOG.md](./docs/CHANGELOG.md) и [ROADMAP.md](./docs/ROADMAP.md).

- **Phase 10** — hardening + v1.0 release: `LICENSE` (Apache 2.0),
  `SECURITY.md`, `make release` собирает `slonk/mcp-kanban:1.0.0` и
  `slonk/backup:1.0.0`; опц. cosign-sign.
- **Phase 9** — backup overlay: pg_dump + mc mirror MinIO + tar mcp_data
  через `supercronic`-cron; `make up-backup`, `make backup-now`.
- **Phase 8** — observability: `/metrics` (Prometheus) + Grafana/Loki/Promtail
  overlay, дашборд `slonk-overview`, alert rules; `make up-obs`.
- **Phase 7** — внешний Caddy TLS-шлюз (`docker-compose.proxy.yml` +
  `caddy/Caddyfile`), `make up-proxy`.
- **Phase 6** — git integration: `link_git_ref` / `unlink_git_ref` /
  `find_issues_by_git_ref` + SQLite-индекс git_refs + corrupt-block recovery.
- **Phase 5** — write tools + atomic claim + audit log + rate limit.
- **Phase 4** — read-only tools + meta-block парсер + TTL cache.
- **Phase 3** — идемпотентный bootstrap (workspace/project/states/labels/identities).
- **Phase 2** — MCP server skeleton (Fastify + MCP StreamableHTTP).
- **Phase 1** — Plane stack v1.3.0 в docker compose.
- **Phase 0** — каркас репозитория и документация.

В коде на сегодня — **22 MCP tool'а**: `who_am_i` + 10 read (`list_*`,
`get_issue`, `search_issues`, `get_issue_history`) + 8 write
(`create_issue`, `update_issue`, `transition_issue`, `claim_issue`,
`release_issue`, `block_issue`, `comment_issue`, `attach_file`) + 3 git
(`link_git_ref`, `unlink_git_ref`, `find_issues_by_git_ref`).

## Конвенции (обязательные)

См. [CONVENTIONS.md](./docs/CONVENTIONS.md). Самое важное при работе с
кодом:

- **TypeScript strict + functional core** — никаких `any` без `eslint-disable`
  с объяснением; бизнес-логика — чистые функции, side-effects на краях.
- **Один tool — один каталог** `src/tools/<tool-name>/{schema,handler,handler.test}.ts`.
  Имя файла — kebab-case, имя tool'а — `snake_case_with_verb`.
- **Tool-контракт** — zod-схема входа, возврат `{ ok: true, data }` или
  `{ ok: false, error: { code, message, trace_id } }`, лог входа/выхода/duration
  с `trace_id`. Все вызовы Plane — через единый `PlaneClient`.
- **ENV** — только через `src/config.ts` (zod-валидация на старте). Никаких
  `process.env.X` в бизнес-коде.
- **Не логируем** `MCP_AUTH_TOKEN`, `PLANE_API_KEY`, `*_PASSWORD`, presigned URL.
  Логгер `pino` уже редактирует эти ключи (см. `src/logger.ts`).
- **Bootstrap идемпотентен** — повторный запуск против заполненного Plane даёт
  `created: 0` по всем коллекциям и `BOOTSTRAP OK`.

### Git workflow

**Базовая ветка.** Разработка ведётся от `main`; для каждой задачи создается
своя ветка и worktree; релизные мержи идут в`develop`. Перед завершением задачи
`merger-agent` сливает фичевую ветку в `develop` и закрывает worktree,
а `release-agent` (если есть) делает PR/MR из `develop` в `main`.
Прямой push в `main` запрещён — только через PR с зелёным CI и approve.

**Имя ветки.** `feature/<IDENT>-<seq>-<slug>`, где `<IDENT>-<seq>` —
issue_id из канбана, `<slug>` — kebab-case из 2–5 слов. Для багфиксов —
`fix/<IDENT>-<seq>-<slug>`, для инфры — `chore/<IDENT>-<seq>-<slug>`.

**Формат коммита.** Conventional Commits:
`<type>(<scope>): <subject> (<IDENT>-<seq>)`. Разрешённые `type`:
`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `build`,
`ci`. `scope` — модуль/каталог. Subject — повелительное наклонение, без
точки в конце, ≤ 72 символов. Issue_id в конце subject обязателен —
именно по нему `find_issues_by_git_ref` связывает коммиты с задачами.

**PR.** Title = subject итогового коммита. Описание содержит:
(1) ссылку на задачу (`Closes <IDENT>-<seq>`), (2) что и зачем (1–3
предложения), (3) test plan / как проверить вручную, (4) breaking
changes — если есть. PR не мержится, если CI красный, не покрыт
тестами там, где это разумно, или не получил approve от
`code-review-agent` + (для security-sensitive) `security-auditor-agent`.
Merge strategy — squash. Сообщение squash-коммита = title PR.

**Версионирование (SemVer).** `MAJOR.MINOR.PATCH`:
- `MAJOR` — обратно несовместимое изменение публичного контракта (API,
  CLI, формат конфига/БД, migration без downgrade).
- `MINOR` — новая обратносовместимая функциональность.
- `PATCH` — багфикс / внутренний рефакторинг без изменения контракта.

Версия живёт в `package.json` / `pyproject.toml` / `VERSION` (зависит
от репо) **и** в git-теге `vX.Y.Z`. Бамп версии делает `merger-agent`
в рамках `Merging`: правит файл версии, добавляет запись в
`CHANGELOG.md` (Keep a Changelog: `### Added / Changed / Fixed /
Removed / Security`), ставит тег `vX.Y.Z` после merge в `main`.

**CHANGELOG.** Формат — [Keep a Changelog](https://keepachangelog.com).
Каждый PR добавляет строку в `[Unreleased]` соответствующей секции.
При релизе `merger-agent` переименовывает `[Unreleased]` в
`[X.Y.Z] — YYYY-MM-DD` и заводит пустой `[Unreleased]`.

**Что запрещено.**
- `force-push` в `main`/`develop` и любые защищённые ветки;
- `--no-verify` для pre-commit / commit-msg / CI-хуков;
- упоминание LLM-агентов, моделей, `Co-Authored-By: <бот>` в
  commit-message и PR-описаниях (это видит человек и внешний
  читатель — пиши как человек о результате, а не о том, кем он
  получен);
- коммитить `.env`, дампы БД, секреты, presigned URL.
- **В описании коммитов НЕ упоминать LLM-агентов, Claude Code, `Co-Authored-By:
  Claude` и подобное.** Это явное требование проекта (CONVENTIONS.md §8.1).
- Каждая фаза = отдельная запись в `[Unreleased]` секции `CHANGELOG.md`.

### Что строго запрещено

- `:latest` в docker-compose;
- коммитить `.env`, дампы БД, секреты, presigned URL;
- `force-push` в `main`;
- `--no-verify` для pre-commit/CI хуков;
- удалять данные пользователя (volume'ы) без явного подтверждения;
- хардкод идентификаторов агентов или ролей вне SQLite/манифеста;
- прямые запросы агента к Plane API в обход MCP.

## Важные особенности

- **Plane backend — один образ**, четыре сервиса. `plane-api`, `plane-worker`,
  `plane-beat`, `plane-migrator` собраны из `makeplane/plane-backend:v1.3.0`,
  отличаются только entrypoint'ом.
- **`plane-proxy` — обязательный front-door**, не опциональный. Фронтенды Plane
  используют same-origin routing с path-префиксами; без `plane-proxy` UI не
  работает. В Phase 7 поверх него встанет внешний `caddy` для TLS.
- **Network-aliases для plane-proxy**: внутри `internal_net` для сервисов
  прописаны короткие aliases (`api`, `web`, `admin`, `space`, `live`,
  `plane-minio`), потому что bundled Caddyfile в `plane-proxy` ссылается на
  именно эти hostname'ы. Не переименовывать сервисы без обновления aliases.
- **Node 22 LTS**, не 20 — `pnpm@11.1.0` спотыкается о `ERR_UNKNOWN_BUILTIN_MODULE`
  на Node 20.19. Закреплено в `.nvmrc` и `engines.node`.
- **Atomic claim** реализован через `UNIQUE`-таблицу `claim_lock` в
  `mcp_data/audit.sqlite` — это единственная serialization-точка. При гонке
  двух `claim_issue` — ровно 1 успех + 1 `CONFLICT`.
- **MCP transport** — единый endpoint `ALL /mcp` через
  `StreamableHTTPServerTransport` (MCP SDK ≥ 1.29), сессия по `mcp-session-id`.
  Никакого отдельного `/mcp/sse`.
- **Healthcheck `plane-api`** — НЕ `/api/v1/health` (его нет у upstream Plane),
  а `GET /` → `{"status":"OK"}`. Не менять без проверки upstream-образа.
- **Bootstrap идентичности** — режим `per_user` (по умолчанию) пытается
  заинвайтить 6 пользователей через `POST /workspaces/<slug>/invitations/`;
  при любой ошибке инвайта fallback на `single_bot`, маппинг `role → plane_user_id`
  пишется в `mcp_data/identity.sqlite`.
