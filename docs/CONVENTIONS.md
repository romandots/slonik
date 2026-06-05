# Конвенции — slonk

Правила, обязательные для всего, что попадает в репозиторий. Нарушение
конвенций — основание отклонить PR.

## 1. Языки и форматирование

| Артефакт | Язык / формат | Тулинг |
|---|---|---|
| MCP server | см. §2 «Стек MCP server» | linter из стека |
| Скрипты | POSIX-sh / bash | `shellcheck` |
| Конфиги Docker | YAML | `yamllint`, `docker compose config` |
| Документация | Markdown (CommonMark + GFM tables) | `markdownlint-cli2` |
| Caddyfile | Caddyfile | `caddy validate` |
| Cron | стандартный cron | — |

Все файлы — UTF-8, LF, без BOM. Trailing whitespace запрещён. Файлы заканчиваются
новой строкой. `.editorconfig` фиксирует это для редактора.

Линтеры запускаются в CI и через `make lint`. Pre-commit hook рекомендуется,
но не обязателен.

## 2. Стек MCP server

Для v1 выбран **TypeScript на Node.js**:

- Официальный `@modelcontextprotocol/sdk` для MCP-протокола (HTTP+SSE + stdio).
- Сильная типизация контрактов tools.
- Lightweight runtime, простая контейнеризация.
- Native JSON, нативный fetch — Plane API лёг ровно.

Опорные пакеты:

| Назначение | Пакет |
|---|---|
| MCP протокол | `@modelcontextprotocol/sdk` |
| HTTP-сервер | `fastify` |
| Валидация | `zod` + `zod-to-json-schema` для генерации JSON Schema |
| HTTP-клиент | нативный `fetch` + `undici` retry-обёртка |
| SQLite | `better-sqlite3` |
| YAML | `yaml` |
| Логирование | `pino` |
| Тесты | `vitest` + `supertest` |
| Линтинг | `eslint` + `@typescript-eslint` |
| Форматирование | `prettier` |
| Пакетный менеджер | `pnpm` (lockfile commit'ится) |

Node-версия — pinned через `.nvmrc` и `engines.node` в `package.json`. v1 целит
на `22.x LTS` (актуальный Active LTS на момент Phase 2; Node 20 в Maintenance —
причина: pnpm 11.x требует Node ≥ 22 из-за используемых встроенных модулей).

Альтернативный стек (Python / Go) допустим только при явном решении в
[CHANGELOG.md](./CHANGELOG.md). Смена стека после Phase 4 — отдельная инициатива.

## 3. Стиль кода (TypeScript)

- `strict: true` в `tsconfig.json`. Никаких `any` без `eslint-disable` с
  объяснением.
- Functional core, imperative shell: бизнес-логика — чистые функции, side-effects
  только на краях (HTTP-хендлеры, Plane-клиент, SQLite-репозитории).
- Один файл — одна публичная сущность (tool / схема / клиент). Имя файла
  совпадает с экспортируемой сущностью в kebab-case: `claim-issue.ts`.
- Без default-экспортов в библиотечном коде. Default-экспорт допустим только
  в entrypoint'е.
- Импорты — относительные внутри одного модуля, абсолютные (`~/…` через
  paths) для cross-module.
- Без I/O в конструкторах — только в явных `init()` / lifecycle hooks.
- Ошибки — типизированные классы `McpError`, `PlaneError`, `ConflictError`.
  Никаких `throw "string"`.

## 4. Конвенции tools

Каждый MCP tool — отдельный модуль вида:

```text
mcp-kanban/src/tools/<tool-name>/
├── schema.ts        # zod-схема входа
├── handler.ts       # реализация
├── handler.test.ts  # unit-тесты
└── integration.test.ts  # против реального Plane
```

Контракт:

- Имя tool — `snake_case_with_verbs`: `claim_issue`, `list_issues`.
- Описание (`description`) — одно предложение + один-два примера в JSDoc.
- Входная схема — `zod`, преобразуется в JSON Schema для MCP.
- Возврат — `{ ok: true, data }` или `{ ok: false, error: { code, message, trace_id } }`.
- Все вызовы Plane API — через единый `PlaneClient`, который сам делает retry/timeout.
- Логировать вход (без секретов), выход и duration с `trace_id`.

## 5. Структура репозитория

```text
slonk/
├── docker-compose.yml
├── docker-compose.dev.yml
├── docker-compose.obs.yml
├── docker-compose.proxy.yml
├── docker-compose.backup.yml
├── .env.example
├── .editorconfig
├── .gitignore
├── .nvmrc
├── Makefile
├── README.md           # короткий, отправляет в docs/
├── plane/
│   └── docs/           # вся проектная документация (этот каталог)
├── mcp-kanban/
│   ├── Dockerfile
│   ├── package.json
│   ├── pnpm-lock.yaml
│   ├── tsconfig.json
│   ├── src/
│   │   ├── server.ts
│   │   ├── auth.ts
│   │   ├── plane-client.ts
│   │   ├── meta-block.ts
│   │   ├── audit/
│   │   ├── identity/
│   │   ├── tools/
│   │   └── bootstrap/
│   ├── schemas/        # сгенерированные JSON Schema (не редактируются вручную)
│   ├── bootstrap/manifest.yaml
│   └── test/
│       ├── integration/
│       └── e2e/
├── caddy/
│   └── Caddyfile
├── prometheus/
├── grafana/
├── loki/
├── promtail/
└── backup/
    ├── Dockerfile
    └── run.sh
```

## 6. Naming

| Что | Правило | Пример |
|---|---|---|
| Docker service | kebab-case, по роли | `plane-api`, `mcp-kanban` |
| Docker network | snake_case + `_net` | `public_net`, `internal_net` |
| Docker volume | snake_case + `_data` / `_logs` | `postgres_data`, `mcp_logs` |
| ENV-переменные | UPPER_SNAKE_CASE, префикс по компоненту | `PLANE_API_KEY`, `MCP_AUTH_TOKEN` |
| MCP tool | snake_case с глаголом | `claim_issue`, `link_git_ref` |
| Agent identity | kebab-case с суффиксом `-agent` | `developer-agent` |
| Plane label | kebab-case | `agent-claimed`, `high-priority` |
| Plane state | Title Case | `In Review` (нет такого, но как пример) |
| Branch | `<type>/<ISSUE-KEY>-<slug>` | `feature/SLONK-123-claim-tool` |
| Файл TS | kebab-case | `claim-issue.ts` |
| Класс TS | PascalCase | `PlaneClient` |
| Функция TS | camelCase | `extractMetaBlock` |
| Constants | UPPER_SNAKE_CASE | `DEFAULT_RETRY_MS` |

## 7. Конфиги

- Все настройки — из `.env`. Code reads `process.env` только через единый модуль
  `src/config.ts`, который валидирует ENV через `zod` на старте.
- Дефолты — в коде и в `.env.example`. `.env.example` всегда актуален, без
  секретов, с комментариями.
- Никаких хардкод-значений в compose-файле — только `${VAR}` или статичные
  системные (порты внутри контейнера, hostname'ы сервисов).
- Чувствительные значения **не** логируются.

## 8. Git workflow

- Основная ветка — `main`. Защищена: PR + 1 ревью + зелёный CI.
- Фичевые ветки — `feature/<ISSUE-KEY>-<slug>`.
- Багфиксы — `fix/<ISSUE-KEY>-<slug>`.
- Инфра — `infra/<ISSUE-KEY>-<slug>`.
- Документация — `docs/<slug>` (issue-key не обязателен для пустых документ-PR).
- Один PR — одна фаза [ROADMAP.md](./ROADMAP.md) или одна задача.

### 8.0 Git worktree (обязательно для агентов)

LLM-агенты (`developer-agent`, `merger-agent`) **обязаны** вести каждую
задачу в отдельной git-worktree, а не в основном working tree клона. Это
изолирует параллельные задачи, позволяет нескольким dev-агентам работать
по одному репозиторию одновременно и не оставляет «грязного» состояния в
основном клоне между переключениями.

**Создание (developer-agent, первое действие шага 5):**

```bash
git worktree add ../<repo-name>-<ISSUE-KEY> -b <type>/<ISSUE-KEY>-<slug> main
# <type> = feature | fix | infra — по типу задачи
```

Путь worktree — рядом с основным клоном, в каталоге уровнем выше
(`../<repo-name>-<ISSUE-KEY>` или `../-worktrees/<ISSUE-KEY>-<slug>`).
Все дальнейшие действия (редактирование, прогон `make test` / `make ci`,
коммиты, `git push`, MCP-вызовы `link_git_ref`) — **из worktree**; в
основном клоне ничего не трогать.

Если worktree создать невозможно (явное указание пользователя в комментариях
задачи; репо ломается на worktree из-за submodule / хуков / build-системы) —
агент обязан `block_issue` с причиной, а **не молча работать в основном
клоне**.

**Закрытие (merger-agent, после перевода задачи в `Done`):**

```bash
git worktree remove ../<repo-name>-<ISSUE-KEY>
git branch -d <type>/<ISSUE-KEY>-<slug>   # если ветка слита и так принято в репо
```

Если worktree-каталог не найден (developer работал в нестандартном пути,
worktree уже снят) — merger отмечает это в комментарии к задаче и пропускает
шаг, не падает. Без этого шага на хосте копятся осиротевшие worktree.

Для людей-контрибьюторов worktree рекомендуется, но не обязателен — это
правило именно про агентский конвейер.

### 8.1 Коммиты

Формат — Conventional Commits:

```text
<type>(<scope>): <subject>

<body>

<footer>
```

`type`: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `infra`, `perf`,
`build`, `ci`.

`scope` — компонент: `mcp`, `plane`, `compose`, `docs`, `bootstrap`, `caddy`,
`backup`, `obs`.

Примеры:

```text
feat(mcp): add claim_issue tool with conflict detection
fix(bootstrap): treat 409 from Plane as idempotent success
infra(compose): pin plane-api to digest sha256:…
docs(roadmap): clarify Phase 5 acceptance
```

В описании коммита **не** упоминаем LLM-агентов, инструменты автоматизации,
Claude Code и тому подобное.

Issue-key (`SLONK-123`) — в footer'е: `Refs: SLONK-123`.

### 8.2 PR

- Шаблон описания: «Что», «Зачем», «Как тестировал», «Чек-лист» (lint, тесты,
  CHANGELOG, docs).
- Минимум один ревьюер.
- PR в `main` мёрджится через squash. История `main` — линейная.

### 8.3 Версионирование

[SemVer](https://semver.org/). До `v1.0.0` всё считается `0.x` и API MCP
может ломаться без MAJOR-бампа (но это фиксируется в CHANGELOG).

Релиз — git-tag `vX.Y.Z` + строка в [CHANGELOG.md](./CHANGELOG.md).

## 9. Тестирование

См. [SPEC.md §11](./SPEC.md#11-тестирование). Дополнительно:

- Unit-тесты обязательны для всей бизнес-логики (парсеры, валидаторы, rate
  limiter, retry).
- Интеграционные тесты используют реальный Plane в Docker — поднимаются через
  `testcontainers` или через переиспользование compose-стека.
- Перед коммитом — `make test`. Перед PR — `make ci` (всё, что делает CI локально).
- Flaky-тесты — баг приоритета high. Запрещено `it.skip` без записи в
  [CHANGELOG.md](./CHANGELOG.md) и issue.

## 10. Документация

- Любое изменение поведения требует обновления соответствующего документа в
  `docs/` в **том же** PR.
- Документация — на русском (язык брифа). Код, идентификаторы, ENV — английский.
- Markdown-таблицы должны рендериться корректно (проверяется `markdownlint`).
- Внутренние ссылки — относительные.
- Скриншоты — в `docs/assets/`, формат PNG, < 200 KB.

## 11. CHANGELOG

Формат — [Keep a Changelog](https://keepachangelog.com/). Файл — [CHANGELOG.md](./CHANGELOG.md).

- Каждая фаза [ROADMAP.md](./ROADMAP.md) — запись.
- Каждое breaking-изменение — отдельный пункт «Changed» с пометкой `**BREAKING:**`.
- Релиз — `## [X.Y.Z] — YYYY-MM-DD`.
- Незарелизенные изменения — в `## [Unreleased]`.

## 12. Безопасность в коде

- Не логируем: `MCP_AUTH_TOKEN`, `PLANE_API_KEY`, `POSTGRES_PASSWORD`,
  `MINIO_ROOT_PASSWORD`, presigned URLs.
- Не сохраняем секреты в SQLite / на диск без необходимости.
- При парсинге внешних данных (meta-блок, описание задачи) — никогда не
  исполняем как код. YAML парсится в safe-режиме.
- HTTP-клиент в Plane-обёртке таймаутит по `MCP_PLANE_TIMEOUT_MS` и имеет
  retry-budget; никаких бесконечных циклов.
- Зависимости — фиксируются в lockfile, обновляются через Dependabot/Renovate
  с отдельным PR.

## 13. Производительность и ресурсы

- Целевой p95 latency MCP tool < 500 ms (read), < 1500 ms (write).
- MCP контейнер: limit `0.5 CPU`, `256 MiB RAM` достаточно для v1.
- Plane сам по себе ресурсоёмкий — рекомендованный лимит контейнеров не
  ставим, полагаемся на upstream.
- N+1 запросы к Plane API — баг. Используем batch-эндпоинты Plane, где есть.

## 14. Что строго запрещено

- `:latest` тэги в docker-compose.
- Коммитить `.env`, дампы БД, секреты, presigned URL.
- `force-push` в `main`.
- Скипать pre-commit / CI хуки (`--no-verify`).
- Удалять данные пользователя (volume) без явной команды человека.
- Хранить идентификаторы агентов или их роли вне SQLite/манифеста (никаких
  хардкодов в коде).
- Прямые запросы агента к Plane API в обход MCP.
