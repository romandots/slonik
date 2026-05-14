# Changelog

Все значимые изменения в slonk фиксируются в этом файле.

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версионирование — [Semantic Versioning](https://semver.org/lang/ru/).

## [Unreleased]

### Added
- **`mcp-kanban/bootstrap/` пробрасывается bind-mount'ом** в контейнер
  `mcp-kanban` (`./mcp-kanban/bootstrap:/app/bootstrap:ro` в
  `docker-compose.yml`). Правки `manifest.yaml` / `manifest.example.yaml`
  подхватываются после `docker compose up -d mcp-kanban` + `make bootstrap`,
  **без `make build`**. Образ продолжает копировать те же файлы (`COPY
  ./bootstrap` в Dockerfile) — это fallback, если bind-mount по какой-то
  причине пуст. Дока (`USER_GUIDE.md §2.2`, `CONFIGURATION.md §тех. структура`)
  обновлена, шаг `docker compose build mcp-kanban` после правок манифеста
  удалён из инструкции.
- **Локальный bootstrap-манифест по аналогии с `.env`**. Файл
  `mcp-kanban/bootstrap/manifest.yaml` теперь — конфиг конкретной установки и
  в git не едет (`.gitignore`). В репозитории остаётся committed-шаблон
  `manifest.example.yaml`. Loader (`src/bootstrap/manifest.ts`) сначала ищет
  `manifest.yaml`, при отсутствии падает на `manifest.example.yaml` — свежий
  чекаут работает без правок, кастомизация (свои проекты / identities) —
  копированием шаблона и правкой локальной копии. `Dockerfile` копирует весь
  `bootstrap/`, runtime сам выбирает приоритетный файл. Документация
  (`USER_GUIDE.md §1`, `§2.2`, `CONFIGURATION.md §тех. структура`) обновлена,
  тест `manifest.test.ts` переписан на инварианты (а не точный список
  проектов) и заодно подправлен под актуальный контракт SPEC §5 — 12 states
  и 7 identities (раньше assert'ы рассинхронились с манифестом и тест падал).
- **`docs/claude/` — стартер-кит для агентов** (SLONK-1). Каталог с готовым
  набором для запуска LLM-агентов поверх slonk:
  `CLAUDE.md` (системная инструкция slonk — вынос `USER_GUIDE.md
  §6.1` 1:1, с ремаркой о синхронизации), `docs/claude/.mcp.json` (пример из
  6 role-based MCP-серверов `slonk-analyst` … `slonk-doc` одним файлом),
  `docs/claude/skills/slonk-{analyst,developer,security-auditor,code-review,qa,doc}/SKILL.md`
  (примеры Claude Code-скиллов: каждый — один и тот же цикл «проверить
  identity → найти задачу в своей колонке → claim → прочитать контекст →
  сделать свою часть → передать дальше», с подстановкой роли/колонки/
  следующей колонки; скиллы не запускают других агентов, передача работы —
  только через `comment_issue` + `transition_issue`), `docs/claude/README.md`
  (как развернуть: куда копировать промпт и скиллы, как прописать
  MCP-серверы, один терминал = одна роль). Заодно: `USER_GUIDE.md §6.1`
  приведён в соответствие с `CLAUDE.md` (обобщённый шаг «передай
  дальше» + абзац «особенность конвейера» + ремарка о синхронизации и ссылка
  на каталог `docs/claude/`); в `README.md` и в дереве «Структура проекта»
  (`CLAUDE.md`) добавлен пункт про `docs/claude/`; в `docs/claude/README.md` —
  явное предупреждение «не инлайнить `MCP_AUTH_TOKEN` в `.mcp.json`».
  _(Каталог изначально создан как `claude/` в корне репо; перенесён в
  `docs/claude/` в рамках SLONK-4 — см. ниже.)_

### Changed
- **Bootstrap устойчив к падению отдельного проекта + pre-flight валидация
  `project.name`.** В `src/bootstrap/runner.ts` цикл по проектам обёрнут в
  try/catch: ошибка на одном проекте (ensureProject / ensureStates /
  ensureLabels) больше не роняет весь bootstrap — фиксируется в
  `BootstrapReport.projects[i].error` (`code: PROJECT_BOOTSTRAP_FAILED`),
  логируется через `logger.error`, цикл идёт дальше, `ensureIdentities`
  отрабатывает в любом случае. `printReport` помечает упавшие проекты
  маркером `FAILED: <reason>`, CLI (`src/bootstrap/cli.ts`) возвращает
  non-zero exit code. В `ManifestSchema` для `projects[].name` добавлен
  regex `/^[A-Za-z0-9 _-]+$/` — те же правила, что и у Plane v1.3.0,
  чтобы кривое имя (точка, em-dash, двоеточие и пр.) падало на
  zod-валидации с понятным сообщением до похода в Plane. Заодно в
  committed-шаблоне `mcp-kanban/bootstrap/manifest.example.yaml` em-dash
  в именах проектов заменён на обычный `-` — иначе Plane на этих именах
  отдавал 400 «Project name cannot contain special characters». Тесты:
  `runner.test.ts` — двухпроектный манифест, где второй падает по 400,
  identities всё равно отрабатывают; `manifest.test.ts` — zod режет
  `name: "foo.bar"` и `name: "Foo — Bar"`. Документация:
  `docs/USER_GUIDE.md §2.2` (раздел «Известные коллизии Plane v1.3.0»)
  получил предупреждение про разрешённый charset и описание поведения
  resilient-цикла.
- **Реструктуризация файловой структуры репозитория** (SLONK-4). Документация
  переехала из `plane/docs/` в `docs/` (8 файлов: `USER_GUIDE`, `SPEC`,
  `ARCHITECTURE`, `CONFIGURATION`, `ROADMAP`, `CONVENTIONS`, `CHANGELOG`,
  `README`); каталог `plane/` удалён. Примеры инструкций для Claude
  (`CLAUDE.md`, `.mcp.json`, `skills/`) переехали из `claude/` в `docs/claude/`.
  Обновлены все cross-ссылки: корневой `README.md`, `CLAUDE.md`, `SECURITY.md`,
  комментарии в `docker-compose.yml` / `docker-compose.dev.yml` / `Makefile`,
  относительные ссылки внутри перенесённых файлов и записи в `CHANGELOG.md`.
  Кодовая база (`mcp-kanban/`) не затронута — путей на `plane/docs` в коде нет.

### Changed
- **Bootstrap реконсилирует набор состояний Plane с манифестом** (SLONK-2,
  SLONK-3). Plane v1.3.0 при создании проекта автоматически заводит
  дефолтные состояния (`Backlog`, `Todo`, `In Progress`, `Done`,
  `Cancelled`). Раньше `ensureStates` сверял манифест строго по `name` и
  лишь доздавал недостающие — поэтому рядом с манифестным `To Do` оставался
  Plane-овский `Todo` (дубль в группе `unstarted`), а `In Progress` висел
  «сиротой». Теперь bootstrap: (1) переиспользует осиротевший дефолт той же
  `group` под манифестное состояние (`PATCH` имени/цвета/`sequence` вместо
  `createState`) — так `Todo` становится `To Do`; (2) удаляет состояния, не
  описанные в манифесте и не помеченные `default` (`In Progress` и т.п.).
  `default`-состояние не переименовывается и не удаляется никогда. Удаление
  лишних колонок — best-effort: если Plane отказал (например, у колонки есть
  привязанные задачи), bootstrap пишет `warn` и продолжает, а не падает.
  `BootstrapReport.states` получил поля `renamed`, `deleted`, `delete_failed`;
  они печатаются в отчёте `make bootstrap` (`states: N created, M renamed,
  K deleted, …`). Bootstrap остаётся идемпотентным: повторный прогон даёт
  `created: 0, renamed: 0, deleted: 0`. В `PlaneClient` добавлены
  `updateState` (PATCH) и `deleteState` (DELETE). Затронуты
  `src/plane-client.ts`, `src/bootstrap/runner.ts`, `src/bootstrap/cli.ts`,
  тесты, `src/tools/test-fakes.ts`, документация (`SPEC.md`,
  `CONFIGURATION.md`, `USER_GUIDE.md`).

### Fixed
- **Caddy healthcheck в `docker-compose.proxy.yml` был битый — контейнер
  всегда был unhealthy**, из-за чего `make up-proxy` валился по таймауту
  `compose --wait`. Старая команда `wget -q -O- --spider http://127.0.0.1/
  2>&1 | grep -qE 'HTTP/1.1 (200|301|308)'` использовала несовместимые
  флаги: `-q` глушит весь вывод wget, поэтому grep никогда не находил
  строку статуса и команда всегда возвращала exit 1. Заменено на проверку
  Caddy admin API (`wget -q --spider http://127.0.0.1:2019/config/`) —
  admin API у Caddy 2 всегда на 127.0.0.1:2019, отдаёт 200, BusyBox-wget
  при 2xx возвращает 0. `start_period` поднят с 10 до 15 секунд под
  cold-start TLS-инициализации. Существующие развёртывания: подтянуть
  файл и `docker compose -f docker-compose.yml -f docker-compose.proxy.yml
  up -d --force-recreate caddy` (или `make up-proxy` ещё раз — compose
  пересоздаст контейнер из-за изменения healthcheck-блока).
- **Дефолт проекта в MCP-конфиге указывал на несуществующий handle.**
  `MCP_DEFAULT_PROJECT` / `MCP_ALLOWED_PROJECTS` имели дефолт `code-agents`
  (это `slug` из `bootstrap/manifest.yaml`, которого Plane не хранит), а
  `resolveProject` матчит ref только по `identifier` / `name` / `id`. В итоге
  любой read/write tool падал с `NOT_FOUND: Project 'code-agents' not found`.
  Дефолт изменён на Plane-идентификатор проекта — `SLONK`. Обновлены
  `src/config.ts`, тесты, `.env.example`, комментарий в `manifest.yaml` и
  документация (`SPEC.md`, `CONFIGURATION.md`, `ARCHITECTURE.md`,
  `USER_GUIDE.md`). Существующие развёртывания: выставить
  `MCP_DEFAULT_PROJECT=SLONK` и `MCP_ALLOWED_PROJECTS=SLONK` в `.env` и
  пересоздать контейнер `mcp-kanban`.

## [1.0.0] — 2026-05-12

Первый стабильный релиз slonk. Закрыты все Phase 0–10 из
[ROADMAP.md](./ROADMAP.md). Acceptance §10 SPEC — выполнено.

### Added
- **Phase 10 — Hardening + v1.0 release.**
  - `LICENSE` — Apache 2.0; `package.json.license` обновлён на
    `Apache-2.0` (был `UNLICENSED`).
  - `SECURITY.md` — короткое summary security-постуры v1.0:
    сеть/публикация портов, секреты, аутентификация, концурентность,
    хранилище MCP, attach_file, recovery; explicit-список того, что v1.0
    НЕ покрывает (multi-tenant, per-agent OAuth, HSM, CA pinning).
  - Образы собственной сборки параметризованы: `slonk/mcp-kanban:${SLONK_MCP_IMAGE_TAG:-1.0.0}`
    в `docker-compose.yml`, `slonk/backup:${SLONK_BACKUP_IMAGE_TAG:-1.0.0}`
    в `docker-compose.backup.yml`. Дев-сборка по-прежнему доступна
    переопределением переменной.
  - `mcp-kanban/package.json.version: 1.0.0` (было `0.1.0`).
  - **`make release`**: `docker build -t slonk/mcp-kanban:$(SLONK_VERSION)
    -t :latest` + то же для backup. Опц. `SLONK_RELEASE_SIGN=1`
    подписывает образы cosign'ом, если он установлен.
  - **Pinned versions:** lockfile `mcp-kanban/pnpm-lock.yaml` уже
    закоммичен (Phase 2); все docker-образы — на semver/release-tag'ах
    (`plane-backend:v1.3.0`, `postgres:15.7-alpine`, `valkey:7.2.11-alpine`,
    `rabbitmq:3.13.6-management-alpine`, `minio:RELEASE.2025-09-07T16-13-09Z`,
    `caddy:2.10.0-alpine`, `prom/prometheus:v3.5.0`, `grafana:11.6.0`,
    `loki:3.4.2`, `promtail:3.4.2`). Pinning на `@sha256:`-digest'ы —
    рекомендация для production, но не enforced (см. SECURITY.md).

### Что входит в v1.0

22 MCP tool'а: `who_am_i` + 10 read + 8 write + 3 git.

10 overlay-целей Makefile: `up` / `up-dev` / `up-proxy` / `up-obs` /
`up-backup`, `backup-now`, `bootstrap`, `release`, `down`, `down-v`.

Persistence: postgres / valkey / rabbitmq / minio / plane_uploads / mcp_data
/ mcp_logs / caddy_data (+ obs/backup tom'а — slonk_prometheus_data,
slonk_grafana_data, slonk_loki_data, slonk_promtail_positions,
slonk_caddy_config, slonk_backup_data).

Audit: SQLite `audit.sqlite` (Phase 5) + `git_refs.sqlite` (Phase 6) +
`identity.sqlite` (Phase 3).

Observability: `/metrics` Prometheus + Grafana dashboard `slonk-overview`
+ Loki+Promtail + 3 alert-rules (`MCPPlaneErrorsHigh`/`MCPRateLimitedSpikes`/
`MCPScrapeDown`).

TLS front-door: external Caddy через overlay, `tls internal` (Caddy CA)
по умолчанию, переключаемо в ACME через `CADDY_TLS_MODE=<email>`.

Backup: `pg_dump` + `mc mirror` MinIO + `tar mcp_data` по `BACKUP_CRON` через
`supercronic`. Опц. external S3 destination через `BACKUP_S3_*`.

Тесты: 114 unit-тестов (см. CHANGELOG ниже для разбивки по фазам).
`make test` зелёный, `pnpm typecheck` чист.

---

## [Pre-1.0 development log]

### Added
- **Phase 9 — Backup.** Расписанный pg_dump + mc mirror MinIO +
  tar mcp_data через overlay `docker-compose.backup.yml`.
  - **`backup/Dockerfile`** на `alpine:3.20`: postgresql16-client +
    `mc` (MinIO client, RELEASE.2025-04-16) + `supercronic@v0.2.32`
    (docker-friendly cron, signal-aware). Multi-arch (amd64 + arm64)
    через `TARGETARCH` ARG.
  - **`backup/run.sh`** (bash): один проход — `pg_dump --format=custom
    | gzip -9` Plane БД, `mc mirror` для `MINIO_BUCKET_PLANE` и
    `MINIO_BUCKET_MCP`, `tar -czf /mcp_data`, опц. `mc cp / mc mirror`
    наружу при `BACKUP_S3_ENDPOINT` (+ `mc mb --ignore-existing`).
    Retention prune локальных копий через
    `find -mtime +${BACKUP_RETENTION_DAYS}`. JSON-логи на stdout
    (одинаковый формат с pino MCP — Promtail соберёт без extra-stages).
  - **`backup/entrypoint.sh`**: 3 режима — `cron` (default,
    supercronic с `$BACKUP_CRON`), `run-once` (одиночный прогон,
    для `make backup-now`), произвольный arg для отладочного `exec`.
  - **`docker-compose.backup.yml`**: сервис `backup`, depends_on
    postgres/minio healthy, volume `slonk_backup_data` для локальных
    дампов, `mcp_data:ro` (бэкап не пишет в этот стор). Все обязательные
    env подтянуты из `.env`.
  - **Makefile:** `up-backup` (поднять стек с overlay) + `backup-now`
    (разовый ad-hoc запуск через `docker compose run --rm backup
    run-once`) + флаг `backup=1`.
  - **`.env.example`:** обновлён комментарий-блок: путь поднятия,
    что именно делает бэкап, как настроить внешний S3.

### Added
- **Phase 8 — Observability.** Prometheus + Grafana + Loki + Promtail
  через overlay `docker-compose.obs.yml` + `/metrics` endpoint в MCP.
  - **`/metrics`** endpoint в MCP (`src/server.ts`): отдаёт Prometheus
    exposition format, гейтится через `MCP_METRICS_ENABLED` (overlay
    выставляет в `1`); по умолчанию — 404, чтобы не светить наружу.
  - **`src/metrics.ts`** (`MetricsRegistry`): обёртка над
    `prom-client@15.1.3` с собственным `Registry`, `setDefaultLabels`
    + `collectDefaultMetrics` (process_*/nodejs_*) + 4 кастомных
    метрики:
      * `mcp_tool_calls_total{tool, outcome, error_code}` — Counter.
      * `mcp_tool_duration_seconds{tool, outcome}` — Histogram c
        bucket'ами от 5ms до 10s.
      * `mcp_plane_errors_total{kind}` — Counter (kind = timeout/4xx/
        5xx/network/other; 404 НЕ считается ошибкой сети).
      * `mcp_rate_limited_total{scope, identity}` — Counter.
  - **Инструментация всех 22 tool'ов:** read-tools переписаны на
    `instrumentRead(ctx, tool, fn)`-обёртку (timing + counter +
    histogram + ok/asError), write-tools используют `withWriteGuard`,
    которая теперь дополнительно пишет метрики и `recordRateLimited`
    при отказе бакетом. `recordPlaneErrorIfApplicable` различает
    PlaneError по `planeStatus` и инкрементит `mcp_plane_errors_total`.
  - **`docker-compose.obs.yml`** overlay: сервисы `prometheus:v3.5.0`,
    `grafana:11.6.0`, `loki:3.4.2`, `promtail:3.4.2`. Все на
    `internal_net`; Grafana и Prometheus публикуются на хост
    (`GRAFANA_HOST_PORT=3001`, `PROMETHEUS_HOST_PORT=9090`). Volume'ы
    `slonk_prometheus_data` / `slonk_grafana_data` / `slonk_loki_data` /
    `slonk_promtail_positions`. Overlay переопределяет
    `mcp-kanban.environment.MCP_METRICS_ENABLED=1`, чтобы скрейп работал.
  - **Configs:** `prometheus/prometheus.yml` (scrape mcp-kanban + self,
    15s interval), `prometheus/rules/slonk.yml` (3 alert-правила:
    `MCPPlaneErrorsHigh`, `MCPRateLimitedSpikes`, `MCPScrapeDown`),
    `loki/loki-config.yml` (tsdb shipper, single-node, retention из
    `LOKI_RETENTION`), `promtail/promtail-config.yml` (docker SD,
    фильтр по project="slonk*", JSON-парсинг pino-логов MCP с
    label-извлечением `level/trace_id/tool`).
  - **Grafana provisioning** (`grafana/provisioning/{datasources,
    dashboards}/`): Prometheus + Loki datasource'ы, file-provider для
    дашбордов. **Дашборд** `grafana/dashboards/slonk-overview.json`
    (uid `slonk-overview`): 6 панелей — rate(tool_calls) by tool,
    latency p50/p95/p99 by tool, errors by tool/error_code,
    plane_errors by kind, rate_limited by scope+identity, MCP error
    logs (Loki).
  - **Makefile**: `up-obs` + `obs=1` флаг; help печатает URL'ы Grafana
    и Prometheus.
  - **`.env.example`**: новые `GRAFANA_HOST_PORT`, `PROMETHEUS_HOST_PORT`,
    блок-описание обновлён.
  - **Тесты:** 8 новых unit-тестов — `metrics.test.ts` (6 — counter,
    success-vs-error, plane_errors, rate_limited, default metrics,
    content-type) + server.test.ts (2 — /metrics→404 when disabled,
    /metrics→200 with MCP_METRICS_ENABLED=1). Total: 114 passing.
  - **Verification:** `docker compose -f docker-compose.yml -f
    docker-compose.obs.yml config` валиден.

### Added
- **Phase 7 — Reverse proxy + TLS.** Внешний Caddy 2.10 как HTTPS-шлюз
  поверх plane-proxy и mcp-kanban.
  - **`docker-compose.proxy.yml`** overlay: добавляет сервис `caddy`,
    снимает host-публикацию портов с `plane-proxy` и `mcp-kanban`
    (через `ports: !reset []` + `expose:`), добавляет volume'ы
    `slonk_caddy_data` (сертификаты) и `slonk_caddy_config`.
    `depends_on: service_healthy` на plane-proxy/mcp-kanban — Caddy
    стартует, когда апстримы готовы.
  - **`caddy/Caddyfile`**: два site-блока — `${CADDY_DOMAIN}` (proxy
    в plane-proxy:80) и `${CADDY_MCP_DOMAIN}` (proxy в
    mcp-kanban:${MCP_SERVER_PORT}). TLS-режим переключается переменной
    `CADDY_TLS_MODE`: `internal` (default, on-prem с self-signed
    Caddy CA) или `<email>` для Let's Encrypt ACME. Заголовки безопасности
    разные для UI (X-Frame-Options/Referrer-Policy) и MCP
    (X-Content-Type-Options/no-referrer).
  - **Makefile**: новые цели `up-proxy` + флаг `proxy=1`. Help-вывод
    показывает HTTPS-URL'ы вместо `localhost:3000`.
  - **`.env.example`**: `CADDY_DOMAIN` default → `plane.localhost`,
    `CADDY_MCP_DOMAIN` → `mcp.localhost`, новый `CADDY_TLS_MODE=internal`,
    опц. `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT` для запуска на
    нестандартных портах.
  - **Verification:** `docker compose -f docker-compose.yml -f
    docker-compose.proxy.yml config` валиден, и в merged-конфиге ports
    публикует ровно один сервис — `caddy: 80/443`. Без overlay базовый
    стек продолжает публиковать `plane-proxy:3000` и `mcp-kanban:8787`
    (dev-friendly).

### Added
- **Phase 6 — Git integration.** Tools `link_git_ref` / `unlink_git_ref` /
  `find_issues_by_git_ref` (бонус), SQLite-индекс `git_refs.sqlite` для
  быстрого lookup и recovery повреждённого meta-блока.
  - **Tools:** `link_git_ref` (идемпотентно по `(issue, repo, commit)`,
    добавляет/мерджит запись в `<!-- slonk:meta v1 -->`),
    `unlink_git_ref` (удаляет коммит или всю repo-запись),
    `find_issues_by_git_ref` (read-only, SQLite-lookup без обращения к
    Plane). Все три зарегистрированы в `src/tools/registry.ts`; write-tools
    идут через `withWriteGuard` (rate-limit + audit), find — мимо.
  - **SQLite-индекс** `mcp_data/git_refs.sqlite`: таблица `git_refs` c
    UNIQUE на `(issue_id, repo_url, commit_sha)` (sentinel `''` для
    записей без коммита, чтобы branch/PR-only был ровно одной строкой
    на пару issue+repo). Индексы по `(repo_url, commit_sha)`,
    `(repo_url, branch)`, `pr_url`, `issue_id`. Класс `GitRefsIndex` с
    методами `upsert / remove / listForIssue / find / close`.
  - **Corrupt-block recovery** (`preserveCorruptDescription` в
    `src/meta-block.ts`): при повреждённом YAML внутри `slonk:meta`
    блок пакуется в fenced-quote (с выбором забора длиннее самой
    длинной последовательности backticks внутри мусора), исходный body
    сохраняется до маркера, поверх него пишется свежий валидный
    meta-блок, и issue помечается лейблом `needs-human`. SPEC §5.6:
    «не разрушает описание». Соответствующий `meta_was_corrupt:true` +
    `meta_recovered:true` в ответе `link_git_ref` сигнализирует
    агенту о произошедшем recovery.
  - **CONFLICT on unlink-with-corrupt:** `unlink_git_ref` не пытается
    угадать, что удалять из сломанного блока — возвращает `CONFLICT`
    с подсказкой «run link_git_ref first to recover». Это сохраняет
    инвариант «никаких разрушительных операций над непонятными
    данными».
  - **Идемпотентность:** при отсутствии изменений описания и labels —
    PATCH в Plane не вызывается. SQLite-индекс upsert'ится в любом
    случае, чтобы починить рассинхрон.
  - **ToolContext.gitRefs** прокинут в `buildServer` через новую опцию
    `gitRefsStorePath` (default `/mcp_data/git_refs.sqlite`); закрытие
    индекса добавлено в `close()`.
  - **Тесты:** 16 новых unit-тестов: git-refs (8 —
    upsert-idempotent/sentinel/multi-commit/find-by-branch/find-by-pr/
    remove-single/remove-all/row-to-public), link-git-ref (5 —
    fresh/idempotent/merge-branch-pr/corrupt-recovery/schema-refine),
    unlink-git-ref (3 — remove-commit/remove-all/conflict-on-corrupt),
    find-issues-by-git-ref (4 — by-commit/by-branch-intersection/
    schema-refine/null-sentinel), meta-block preserve (3 —
    happy/no-marker/long-fence). `pnpm test` — 122 passed.
  - **Fix:** `src/server.test.ts` ранее падал в beforeAll
    (`ENOENT: /mcp_data`) на macOS — теперь использует `mkdtempSync`
    и прокидывает пути для всех трёх SQLite-стораджей.

### Added
- **Phase 5 — Write MCP tools (без git).** 8 tool'ов для модификации
  состояния доски, atomic claim, audit log, rate limiting.
  - **Tools:** `create_issue`, `update_issue`, `transition_issue`,
    `claim_issue`, `release_issue`, `block_issue`, `comment_issue`,
    `attach_file` (двухфазный presign / complete для MinIO).
  - **Atomic claim** через таблицу `claim_lock` в `mcp_data/audit.sqlite`:
    UNIQUE-constraint `issue_id` — single serialization point. Параллельный
    `claim_issue` двух identity на одну задачу даёт ровно 1 успех + 1
    `CONFLICT`. При сбое Plane patch'а — claim откатывается, повторный
    вызов возможен.
  - **Audit log** (`mcp_data/audit.sqlite`, таблица `audit_log`): пишется
    `trace_id, ts, identity, tool, input_hash, outcome, error_code, event,
    issue_id` для **каждой** write-операции (успех/ошибка/rate-limit).
    Rate-limit error пишется отдельной записью.
  - **Rate limiter** (`src/rate-limit.ts`): token-bucket in-memory с двумя
    bucket'ами — глобальный (`MCP_RL_GLOBAL_RPS`, default 20) и
    per-identity (`MCP_RL_IDENTITY_RPS`, default 5). Превышение →
    `RATE_LIMITED` с `retry_after_ms` в message.
  - **Префикс комментариев** `[<role>]:` (через `formatComment`) во всех
    tool'ах, что пишут в Plane comments (`comment_issue`,
    `transition_issue`, `claim_issue`, `block_issue`, `attach_file`).
    HTML-экранирование пользовательского ввода.
  - **MCP_BUCKET для attach_file** — добавлены конфиг-ключи
    `MINIO_BUCKET_MCP` (default `mcp-artifacts`),
    `MINIO_INTERNAL_ENDPOINT` (default `http://minio:9000`),
    `PLANE_SIGNED_URL_EXPIRATION` (default 3600 сек).
  - **Тесты:** 19 новых unit-тестов: rate-limit (4 — global/identity/refill/cross),
    audit (4 — record/atomic-claim/release/hash), claim_issue (3 —
    happy-path/race-CONFLICT/rollback), release_issue (2 — own/foreign),
    create_issue (2 — happy/unknown-label), comment_issue (2 —
    format/post), attach_file (2 — presign/complete). Race-тест
    выполняет 2 параллельных `claim_issue` через `Promise.allSettled` и
    проверяет 1 fulfilled + 1 rejected с `code=CONFLICT`.
- **Phase 4 — Read-only MCP tools.** 10 read-tool'ов для чтения состояния
  доски, meta-блок парсер, in-memory кеш.
  - **Tools:** `list_workspaces`, `list_projects`, `list_states`,
    `list_labels`, `list_cycles`, `list_modules`, `list_issues`,
    `get_issue`, `search_issues`, `get_issue_history`. Все
    зарегистрированы в `src/tools/registry.ts`; имена возвращаются через
    `/mcp/tools`.
  - **Parser `<!-- slonk:meta v1 -->`** (`src/meta-block.ts`): идемпотентный
    разбор description'а Plane-задачи на body + YAML meta-блок с
    `repos[]`. Повреждённый блок не разрушается — поднимается флаг
    `meta_corrupt:true` (вызывающий обязан пометить `needs-human`).
    Helpers `upsertGitRef` / `removeGitRef` для будущего Phase 6.
  - **In-memory кеш** (`src/cache.ts`): TTL=10 сек по
    `tool+inputHash`. Read-tools мемоизируют Plane-ответы; write-tools
    вызывают `cache.clear()` после успеха.
  - **Schema-валидация входа** — zod-схемы (`src/tools/<tool>/schema.ts`)
    конвертируются MCP SDK в JSON Schema автоматически. Filtering в
    `list_issues` — `state`, `label`, `assignee`, `cycle`, `module`,
    `priority`, `limit` (с string→id-резолвом по `listStates`/`listLabels`).
  - **`get_issue`** возвращает meta-блок отдельным полем `meta`, body —
    в `description_body`. Поддерживает оба формата issue_id: uuid и
    `SLONK-123` (через `parseIssueRef`).
  - **Тесты:** 16 новых unit-тестов: meta-block (11 — parse/serialize/
    upsert/remove/corruption), cache (5 — ttl/expire/memoize/clear/hash),
    list_issues (4 — filters/allow-list/cache-hit), get_issue (3 —
    meta-extraction/corrupt/not-found), list_states (1 — smoke),
    search_issues (1).
- **Phase 3 — Bootstrap.** Идемпотентная инициализация Plane workspace /
  project / states / labels / identities из YAML-манифеста.
  - **CLI** `mcp-kanban bootstrap` (через `node dist/server.js bootstrap`):
    диспатч из `src/server.ts` загружает `bootstrap/manifest.yaml`,
    валидирует через zod (`src/bootstrap/manifest.ts`), запускает
    `runBootstrap` и печатает многострочный отчёт + `BOOTSTRAP OK`.
    `make bootstrap` дёргает CLI внутри `docker compose run --rm`.
  - **Plane REST-клиент** (`src/plane-client.ts`): полная обёртка над
    `/workspaces/` / `/projects/` / `/states/` / `/labels/` / `/cycles/` /
    `/modules/` / `/issues/` / `/activities/` / `/comments/` /
    `/members/` / `/invitations/` с единой retry-логикой (3 попытки,
    exponential backoff на 429/5xx), таймаутом
    `MCP_PLANE_TIMEOUT_MS` и `X-Api-Key`-аутентификацией.
  - **Идемпотентный runner** (`src/bootstrap/runner.ts`): get-by-slug /
    get-by-identifier / list+diff-by-name для каждой коллекции; создаёт
    только недостающее. Повторный запуск против заполненного Plane —
    `created: 0` по всем категориям.
  - **Identities**: per_user-режим инвайтит каждого `*-agent` через
    `POST /workspaces/<slug>/invitations/` и пишет маппинг
    `role → plane_user_id` в SQLite. При любой ошибке инвайта — fallback
    на `single_bot` (single Plane user, dispatch по префиксу комментария
    `[<role>]:`), warning в логе и `fallback_reason` в отчёте.
  - **SQLite-стор identity** (`src/bootstrap/store.ts`): файл
    `mcp_data/identity.sqlite`, таблицы `identity_mapping` +
    `bootstrap_meta`. `IdentityStore.upsert()` идемпотентен; close()
    обязателен.
  - **Манифест** (`mcp-kanban/bootstrap/manifest.yaml`): workspace
    `agents`, project `SLONK / code-agents` (modules: cycles/modules/views/
    pages), 11 states (Backlog→Cancelled), 14 labels, 6 identities — точно
    по [CONFIGURATION.md §4](./CONFIGURATION.md#4-bootstrap-plane).
  - **Stack-deps:** `better-sqlite3@^11.7` (native: `apk add python3 make g++`
    в builder-stage Dockerfile, `pnpm-workspace.yaml.onlyBuiltDependencies`
    разрешает postinstall),`yaml@^2.6`, `@types/better-sqlite3@^7.6`.
    Compose-volume'ы `mcp_data` + `mcp_logs` для SQLite/логов.
  - **Тесты:** 12 unit-тестов: manifest-загрузка (3 — shipped/bad-group/
    bad-color), identity-store (4 — upsert/overwrite/sort/meta), runner
    (4 — fresh/idempotent/fallback/single_bot-explicit) с in-memory
    fake-PlaneClient.

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
  `docs/`, `.gitignore` (секреты, ноды-артефакты, docker-volume'ы,
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

| Версия | Дата | Контент |
|---|---|---|
| 1.0.0 | 2026-05-12 | Первый стабильный релиз. Phases 0–10 закрыты. |

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
