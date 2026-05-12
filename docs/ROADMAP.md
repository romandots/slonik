# Roadmap — slonk

Поэтапный план реализации. Каждая фаза — отдельная ветка/PR, отдельная запись в
[CHANGELOG.md](./CHANGELOG.md). Acceptance внутри фазы — это то, что должно
быть зелёным до перехода к следующей. Каждая фаза начинается с создания новой feature-ветки от ветки `plane` (или от предыдущей фазы), содержит инкрементальные conventional-commits и заканчивается merge в `plane` после успешного прохождения acceptance-критериев.

Принципы:

- Никаких пропусков фаз: следующая собирается поверх предыдущей.
- Каждая фаза заканчивается рабочим, демонстрируемым результатом.
- В конце фазы — `make test` зелёный, документация обновлена, тэг в `CHANGELOG.md`.

## Phase 0 — Скелет репозитория ✅ DONE

**Цель:** репозиторий готов к разработке. Никакой инфраструктуры ещё нет.

Деливериблы:

- `README.md`, `SPEC.md`, `ARCHITECTURE.md`, `CONFIGURATION.md`, `ROADMAP.md`,
  `CONVENTIONS.md`, `CHANGELOG.md` (этот PR).
- `.gitignore`, `.editorconfig`, `.env.example` (стартовая версия).
- Структура каталогов: `mcp-kanban/`, `caddy/`, `prometheus/`, `grafana/`,
  `loki/`, `promtail/`, `backup/`.
- `Makefile` с пустыми целями `up`, `down`, `logs`, `test`, `bootstrap`.
- CI заготовка (GitHub Actions / GitLab CI): lint markdown, проверка `.env.example`.

Acceptance:

- [x] Все .md-документы существуют и валидны (markdown lint).
- [x] `make` без аргументов печатает список целей.
- [ ] CI зелёный. _(отложено — см. CHANGELOG decision: CI на v1 не делаем)_

## Phase 1 — Plane stack ✅ DONE

**Цель:** Plane поднимается локально с персистентным хранилищем, UI открывается.

Реальный набор сервисов Plane v1.3.0 шире, чем планировалось в первоначальной
формулировке фазы: помимо `plane-api`/`plane-worker`/`plane-beat`/`plane-web`
upstream требует `plane-migrator` (one-shot миграций), `plane-admin`
(god-mode UI для первичной настройки админа), `plane-live` (realtime), и
`plane-space` (публичные share-views) — все из единого образа
`makeplane/plane-backend:v1.3.0` либо одноимённых фронтенд-образов. Плюс
`plane-proxy` (Caddy) — обязательная входная точка, потому что фронтенды
upstream собраны со same-origin routing.

Деливериблы:

- `docker-compose.yml` со всеми Plane-сервисами v1.3.0
  (`plane-proxy`, `plane-web`, `plane-admin`, `plane-space`, `plane-live`,
  `plane-api`, `plane-worker`, `plane-beat`, `plane-migrator`) и
  инфра-сервисами (`postgres:15.7-alpine`, `valkey/valkey:7.2.11-alpine`,
  `rabbitmq:3.13.6-management-alpine`, `minio` на pinned-релизе).
- `docker-compose.dev.yml` overlay с публикацией портов БД/MinIO/API на хост.
- Сети `public_net` и `internal_net` с правильным распределением сервисов;
  network-aliases (`api`, `web`, `admin`, `space`, `live`, `plane-minio`,
  `plane-db`, `plane-redis`, `plane-mq`) для совместимости с bundled
  Caddyfile внутри `plane-proxy`.
- Volume'ы `postgres_data`, `redis_data`, `rabbitmq_data`, `minio_data`,
  `plane_uploads`.
- Healthcheck'и для всех длительных сервисов; `depends_on:
  condition: service_healthy` для зависимостей и
  `condition: service_completed_successfully` для one-shot `plane-migrator`.
- `.env.example` дополнен Plane/Postgres/Valkey/RabbitMQ/MinIO-переменными.
- `make up` поднимает стек (`docker compose up -d --wait`),
  `make smoke` проверяет статус и Plane UI на `${PLANE_HOST_PORT}`.

Acceptance:

- [x] `docker compose up -d --wait` → все сервисы healthy за < 90 сек после
      того, как образы скачаны (первый запуск дольше из-за `docker pull`).
- [x] Plane UI доступен на `http://localhost:3000` (через `plane-proxy`).
- [x] `/god-mode` UI доступен на том же origin'е, позволяет создать
      первого admin'а (`plane-admin` сервис проксируется по `/god-mode/*`).
- [x] `docker compose down && docker compose up -d` сохраняет данные.
- [x] Порты Postgres/Redis/RabbitMQ/MinIO/plane-api **не** опубликованы на
      хост в базовом compose-файле (проверяется `docker compose port` и
      `nmap`).
- [x] `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d`
      публикует их для отладки.

## Phase 2 — MCP server skeleton ✅ DONE

**Цель:** контейнер MCP запускается, отвечает на `/health`, регистрирует один
эхо-tool через MCP-протокол.

Деливериблы:

- `mcp-kanban/` — выбор стека (см. [CONVENTIONS.md](./CONVENTIONS.md#стек-mcp-server)).
- `Dockerfile` с multi-stage build, итоговый образ < 200 MB.
- HTTP+SSE сервер MCP с эндпоинтами `/health`, `/mcp`, `/mcp/sse`.
- Bearer-auth и проверка `X-Agent-Identity`.
- Один tool `who_am_i` — возвращает identity и версию.
- Структурный JSON-лог в stdout.
- Compose: сервис `mcp-kanban` на обоих сетях, healthcheck.
- Unit-тесты для роутинга и аутентификации.

Acceptance:

- [x] `make up` поднимает MCP вместе с Plane-стеком.
- [x] `curl /health` без токена возвращает 200 c `plane_reachable:true`.
- [x] `curl /mcp/tools` без токена возвращает 401.
- [x] `curl -H "Authorization: …" -H "X-Agent-Identity: developer-agent" /mcp` →
      MCP handshake успешен.
- [x] Тест `who_am_i` через MCP-клиент возвращает корректную identity.

## Phase 3 — Bootstrap-команда ✅ DONE

**Цель:** идемпотентный bootstrap создаёт workspace/project/states/labels.

Деливериблы:

- `mcp-kanban bootstrap` — CLI-команда.
- `bootstrap/manifest.yaml` — манифест из [CONFIGURATION.md](./CONFIGURATION.md#4-bootstrap-plane).
- Plane-клиент в MCP (тонкая обёртка над REST API).
- Идемпотентная логика: получить → сравнить → создать недостающее.
- Создание Plane-пользователей для агент-identities (если API позволяет) с
  fallback на `single_bot` режим.
- Запись маппинга identity → plane_user_id в SQLite (`mcp_data/identity.sqlite`).
- Интеграционный тест: запустить bootstrap дважды против чистого Plane —
  без ошибок, без дублей.

Acceptance:

- [x] `docker compose run --rm mcp-kanban bootstrap` против чистого Plane —
      успешно, выводит `BOOTSTRAP OK`.
- [x] Повторный запуск — `BOOTSTRAP OK` без изменений на стороне Plane (diff пуст).
- [x] Если bootstrap не смог создать пользователей — переключается на
      `single_bot`, логирует warning, продолжает.
- [x] В Plane UI видны все 11 states, 14 labels и (при `per_user`) 6
      identity-пользователей.

## Phase 4 — Read-only MCP tools ✅ DONE

**Цель:** агент может читать состояние доски.

Деливериблы:

- Tools: `list_workspaces`, `list_projects`, `list_states`, `list_labels`,
  `list_cycles`, `list_modules`, `list_issues`, `get_issue`, `search_issues`,
  `get_issue_history`.
- Парсер meta-блока `<!-- slonk:meta v1 -->` (см. [SPEC.md](./SPEC.md#56-привязка-к-репозиториям)).
- Schema-валидация входа по JSON Schema.
- Кеш Plane-ответов в памяти на 10 секунд (по `tool+input_hash`).
- Контрактные тесты: для каждого tool — входная схема, выходная форма.
- Интеграционные тесты против реального Plane: создать тестовую задачу через
  Plane API, прочитать через MCP.

Acceptance:

- [x] Все 10 read-tools работают.
- [x] `list_issues` с фильтрами `state`, `label`, `assignee`, `cycle` — корректные
      результаты.
- [x] `get_issue` возвращает meta-блок отдельным полем `meta`.
- [x] Тестовое покрытие read-логики ≥ 70%.

## Phase 5 — Write MCP tools (без git) ✅ DONE

**Цель:** агент может создавать/менять задачи.

Деливериблы:

- Tools: `create_issue`, `update_issue`, `transition_issue`, `claim_issue`,
  `release_issue`, `block_issue`, `comment_issue`, `attach_file` (+ presign
  flow к MinIO).
- Atomic claim с conflict detection (см. [SPEC.md §6.5](./SPEC.md#65-идемпотентность-и-конкурентность)).
- Audit log в SQLite (`mcp_data/audit.sqlite`).
- Rate limiter (token bucket).
- Префикс `[<role>]:` в комментариях.
- Тест на claim race: 2 параллельных claim_issue → 1 успех + 1 `CONFLICT`.
- Тест на attach_file: presigned PUT → объект появляется в MinIO → metadata
  привязана к issue в Plane.

Acceptance:

- [x] Все write-tools работают.
- [x] Race-тест зелёный.
- [x] Rate limit срабатывает при превышении и возвращает `retry_after_ms`.
- [x] Audit log заполняется для каждой write-операции.
- [ ] Acceptance-сценарий из [SPEC.md §10](./SPEC.md#10-acceptance-criteria-для-v10) проходит вручную. _(до v1 — финальная проверка перед релизом Phase 10)_

## Phase 6 — Git integration ✅ DONE

**Цель:** задачи связаны с репозиториями, ветками, PR, коммитами.

Деливериблы:

- Tools: `link_git_ref`, `unlink_git_ref`.
- Writer meta-блока: идемпотентный, не разрушает существующий контент описания.
- Recovery: если блок повреждён — пишет валидный рядом, ставит лейбл `needs-human`.
- SQLite-индекс `git_refs` для быстрого поиска по коммитам / веткам / PR.
- Tool `find_issues_by_git_ref` (бонус, опционально в v1).
- Конвенция именования веток `feature/<ISSUE-KEY>-<slug>` зафиксирована в
  [CONVENTIONS.md](./CONVENTIONS.md#git-workflow).

Acceptance:

- [x] `link_git_ref` идемпотентно: повторный вызов с теми же параметрами не
      дублирует запись в meta-блоке.
- [x] При повреждённом meta-блоке — MCP не удаляет данные, ставит `needs-human`.
- [x] `get_issue` возвращает meta-блок как структурированный объект.

## Phase 7 — Reverse proxy + TLS ✅ DONE

**Цель:** прод-ready публичный доступ.

Деливериблы:

- `docker-compose.proxy.yml` overlay с сервисом `caddy`.
- `caddy/Caddyfile` с разделением `plane-web` и `mcp-kanban` по поддоменам.
- Том `caddy_data` для ACME-сертификатов.
- Документация: как настроить DNS / `tls internal` для on-prem.
- Закрытие dev-портов в базовом compose (`3000`, `8000`, `8787` публикуются
  только в `dev.yml`).

Acceptance:

- [x] С `make up-proxy` (overlay `docker-compose.proxy.yml`) Caddy слушает
      80/443; plane и MCP отдаются по HTTPS на `${CADDY_DOMAIN}` /
      `${CADDY_MCP_DOMAIN}`.
- [x] С proxy overlay базовые порты (`3000`, `8787`) НЕ публикуются —
      `docker compose config` показывает только `caddy: 80/443`.
- [x] Без overlay в прод-режиме порты Postgres/Redis/RabbitMQ/MinIO не
      торчат наружу (gate Phase 1, проверяется `docker compose port`).

## Phase 8 — Observability ✅ DONE

**Цель:** видимость состояния системы.

Деливериблы:

- `docker-compose.obs.yml` overlay: prometheus, grafana, loki, promtail.
- Эндпоинт `/metrics` в MCP с метриками из [SPEC.md §12](./SPEC.md#12-метрики-и-observability-опционально-профиль---profile-obs).
- Дашборд `slonk-overview` для Grafana — provisioned.
- Алерты Prometheus: `mcp_plane_errors_total` rate > 0.1/s, `mcp_rate_limited_total`,
  отсутствие scrape > 1 мин.

Acceptance:

- [x] Grafana показывает дашборд `slonk-overview` (provisioned) c rate(tool_calls),
      latency p50/p95/p99, ошибки по tool/error_code, plane_errors, rate-limit.
- [x] Promtail тейлит все docker-логи стека → Loki, JSON-логи MCP парсятся в
      labels `level/trace_id/tool`. Дашборд имеет панель «MCP error logs».
- [x] Prometheus rules: `MCPPlaneErrorsHigh` (>0.1/s 1m), `MCPRateLimitedSpikes`
      (>0 за 5m), `MCPScrapeDown` (up==0 1m).

## Phase 9 — Backup ✅ DONE

**Цель:** регулярный бэкап + проверенная процедура восстановления.

Деливериблы:

- `docker-compose.backup.yml` overlay с сервисом `backup`.
- Скрипт `backup/run.sh`: `pg_dump` + `mc mirror` MinIO + tar `mcp_data`.
- Cron внутри контейнера.
- Документация процедуры восстановления (уже в [CONFIGURATION.md](./CONFIGURATION.md#восстановление-из-бэкапа)).
- DR-тест в CI: поднять stack → создать issue → бэкап → удалить volume →
  восстановить → проверить, что issue на месте.

Acceptance:

- [x] Бэкап выполняется по расписанию (supercronic с `BACKUP_CRON`,
      default `0 3 * * *` UTC).
- [x] Разовый запуск через `make backup-now` (`run-once` sub-command
      entrypoint'а).
- [x] При `BACKUP_S3_ENDPOINT` — файлы дополнительно заливаются в
      внешний S3 (`mc cp` для дампа/тарбола, `mc mirror` для MinIO).
- [ ] DR-тест end-to-end (поднять → создать → бэкап → удалить volume →
      restore) — задокументирован в CONFIGURATION.md §9, ручная процедура;
      автоматизация — после v1.0 (нет CI на v1).

## Phase 10 — Hardening и v1.0 ✅ DONE

**Цель:** релизная готовность.

Деливериблы:

- Security review (внутренний, по [SPEC.md §8](./SPEC.md#8-безопасность) и [ARCHITECTURE.md §9](./ARCHITECTURE.md#9-модель-угроз)).
- Pin всех образов на конкретные digest'ы.
- Lock-файлы зависимостей MCP commited (lockfile из выбранного package manager).
- `LICENSE`-файл (выбор лицензии).
- `make release` собирает образ `slonk/mcp-kanban:1.0.0` и подписывает.
- Запись `v1.0.0` в [CHANGELOG.md](./CHANGELOG.md) с полным списком фичей.

Acceptance:

- [x] Tag `v1.0.0` в git (создаётся после squash-merge Phase 10 в `plane`).
- [x] `make release` собирает `slonk/mcp-kanban:1.0.0` и `slonk/backup:1.0.0`,
      опц. подписывает cosign'ом при `SLONK_RELEASE_SIGN=1`.
- [x] `LICENSE` (Apache 2.0) + `SECURITY.md` (security posture summary).
- [x] Документация фаз 0–10 в CHANGELOG.md соответствует реальному
      поведению (verified): 22 tool'а, 7 compose-overlay'ев, 114 unit-тестов.
- [ ] Acceptance §10 SPEC end-to-end в реальном окружении — требует
      ручного прогона на свежем стенде (документировано в SPEC.md);
      автоматизация — будущая фича (нет CI на v1).

## После v1.0 — кандидаты

Не входят в v1, но архитектура готова:

- Webhook-реактор (Plane → MCP → автоматические переходы на основе событий).
- Multi-project / multi-workspace из коробки.
- Альтернативные backend'ы (Jira/Linear) за общим интерфейсом `IssueTrackerClient`.
- Кэширование Plane-ответов в Redis для холодного MCP.
- Sidecar для семантического поиска по issues (embedding + vector store).
- HA-режим (Postgres replica, два MCP за LB).
- Per-agent OAuth-токены вместо общего `MCP_AUTH_TOKEN`.
