# Конфигурация — slonk

Полный референс конфигурации. Источник правды для `.env.example` и
`docker-compose.yml`. Любое изменение конфигурации без обновления этого файла
считается багом.

## 1. Файлы конфигурации

```text
slonk/
├── docker-compose.yml          # базовый стек
├── docker-compose.dev.yml      # overlay: публикация портов БД/MinIO на хост
├── docker-compose.obs.yml      # overlay: prometheus/grafana/loki/promtail
├── docker-compose.backup.yml   # overlay: backup-сервис
├── .env                        # секреты, локально, не в git
├── .env.example                # шаблон без секретов
├── caddy/
│   └── Caddyfile               # обратный прокси (опц.)
├── mcp-kanban/
│   ├── Dockerfile
│   └── bootstrap/                # bind-mount'ится в /app/bootstrap:ro в mcp-kanban (правки без ребилда)
│       ├── manifest.example.yaml # committed pristine-шаблон (workspace/projects/states/labels/identities)
│       └── manifest.yaml         # локальный конфиг установки, gitignored (cp из *.example.yaml)
├── prometheus/prometheus.yml
├── grafana/provisioning/…
├── loki/loki-config.yaml
├── promtail/promtail-config.yaml
└── backup/
    └── crontab
```

Запуск с overlay'ами:

```bash
docker compose -f docker-compose.yml -f docker-compose.obs.yml up -d
```

Профили (альтернатива overlay'ам, для коротких включений отдельных сервисов):

```bash
docker compose --profile backup up -d
```

## 2. `.env` reference

Все переменные. Те, что отмечены **(secret)** — обязаны быть переопределены
перед первым запуском; bootstrap отказывается стартовать с дефолтными значениями
вида `change_me`.

### 2.1 Plane

| Переменная | Default | Описание |
|---|---|---|
| `PLANE_IMAGE_TAG` | `v1.3.0` | Версия upstream-образов `makeplane/plane-*` |
| `PLANE_DOMAIN` | `http://localhost:3000` | Публичный URL Plane UI (через `plane-proxy`) |
| `PLANE_HOST_PORT` | `3000` | Хост-порт, на котором публикуется `plane-proxy` (контейнер слушает `:80`) |
| `PLANE_APP_DOMAIN` | `localhost` | Домен Caddy внутри `plane-proxy`; `localhost` = без TLS |
| `PLANE_SITE_ADDRESS` | `:80` | Listen-адрес Caddy внутри `plane-proxy` |
| `PLANE_API_BASE_URL` | `http://plane-api:8000/api/v1` | Внутренний URL API для MCP |
| `PLANE_API_KEY` | — | API-ключ workspace-admin'а **(secret)**, заполняется после bootstrap'а UI |
| `PLANE_SECRET_KEY` | `change_me` | Django SECRET_KEY **(secret)**, `openssl rand -hex 32` |
| `PLANE_LIVE_SECRET_KEY` | `change_me` | HMAC-секрет между `plane-api` и `plane-live` **(secret)** |
| `PLANE_DEBUG` | `0` | Debug-режим Django (`0`/`1`) |
| `PLANE_CORS_ALLOWED_ORIGINS` | `http://localhost:3000` | Comma-separated CORS |
| `PLANE_GUNICORN_WORKERS` | `1` | Кол-во gunicorn-воркеров `plane-api` |
| `PLANE_API_KEY_RATE_LIMIT` | `60/minute` | Rate limit для API-ключей Plane |
| `PLANE_HARD_DELETE_AFTER_DAYS` | `60` | Через сколько дней soft-deleted объекты удаляются окончательно |
| `PLANE_FILE_SIZE_LIMIT` | `5242880` | Лимит размера upload'а (байт), default 5 MiB |
| `PLANE_SIGNED_URL_EXPIRATION` | `3600` | TTL presigned URL'ов (сек) |
| `PLANE_APP_BASE_URL` | `http://localhost:3000` | Base URL для пользовательского UI |
| `PLANE_APP_BASE_PATH` | (пусто) | Path prefix для UI |
| `PLANE_ADMIN_BASE_URL` | `http://localhost:3000` | Base URL для god-mode |
| `PLANE_ADMIN_BASE_PATH` | `/god-mode` | Path prefix для god-mode |
| `PLANE_SPACE_BASE_URL` | `http://localhost:3000` | Base URL для публичных views |
| `PLANE_SPACE_BASE_PATH` | `/spaces` | Path prefix для публичных views |
| `PLANE_LIVE_BASE_URL` | `http://localhost:3000` | Base URL для realtime |
| `PLANE_LIVE_BASE_PATH` | `/live` | Path prefix для realtime |

### 2.2 Postgres

| Переменная | Default | Описание |
|---|---|---|
| `POSTGRES_DB` | `plane` | имя БД |
| `POSTGRES_USER` | `plane` | пользователь |
| `POSTGRES_PASSWORD` | `change_me` | **(secret)** |
| `POSTGRES_HOST` | `postgres` | hostname в `internal_net` (алиас `plane-db`) |
| `POSTGRES_PORT` | `5432` | внутренний порт |

Compose автоматически собирает `DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}` для plane-backend.

### 2.3 Redis / Valkey

| Переменная | Default | Описание |
|---|---|---|
| `REDIS_HOST` | `redis` | hostname |
| `REDIS_PORT` | `6379` | порт |
| `REDIS_PASSWORD` | — | опц. **(secret)** |

### 2.4 RabbitMQ

| Переменная | Default | Описание |
|---|---|---|
| `RABBITMQ_HOST` | `rabbitmq` | hostname в `internal_net` (алиас `plane-mq`) |
| `RABBITMQ_PORT` | `5672` | AMQP-порт |
| `RABBITMQ_DEFAULT_USER` | `plane` | |
| `RABBITMQ_DEFAULT_PASS` | `change_me` | **(secret)** |
| `RABBITMQ_DEFAULT_VHOST` | `plane` | virtual host для Plane |

Compose автоматически собирает `AMQP_URL` для Celery из этих значений.

### 2.5 MinIO

| Переменная | Default | Описание |
|---|---|---|
| `MINIO_ROOT_USER` | `plane` | проксируется в Plane как `AWS_ACCESS_KEY_ID` |
| `MINIO_ROOT_PASSWORD` | `change_me` | **(secret)** проксируется как `AWS_SECRET_ACCESS_KEY` |
| `MINIO_BUCKET_PLANE` | `plane-uploads` | bucket для вложений Plane (создаётся автоматически на старте `plane-api`) |
| `MINIO_BUCKET_MCP` | `mcp-artifacts` | bucket для агент-артефактов (используется `attach_file`) |
| `MINIO_INTERNAL_ENDPOINT` | `http://minio:9000` | Внутренний URL MinIO/S3, используется MCP для presign'а в `attach_file`. По умолчанию hardcoded в compose; переопределяется только при внешнем S3 |
| `MINIO_REGION` | `us-east-1` | |
| `MINIO_USE` | `1` | `1` — bundled MinIO; `0` — внешний S3 (тогда заполнить `AWS_S3_ENDPOINT_URL`) |
| `MINIO_ENDPOINT_SSL` | `0` | TLS у внешнего S3 endpoint'а (`0`/`1`) |

### 2.6 MCP Server

| Переменная | Default | Описание |
|---|---|---|
| `MCP_SERVER_PORT` | `8787` | HTTP/SSE порт |
| `MCP_AUTH_TOKEN` | `change_me` | Bearer для агентов **(secret)** |
| `MCP_DEFAULT_WORKSPACE` | `agents` | slug рабочего workspace |
| `MCP_DEFAULT_PROJECT` | `SLONK` | Plane-идентификатор проекта по умолчанию, если агент не передал `project` в MCP-вызов |
| `MCP_ALLOWED_PROJECTS` | `SLONK` | comma-separated whitelist проектов, к которым MCP даёт доступ (identifier / имя / нормализованный slug / UUID). Multi-project: `CODE_AGENTS,BACKEND,WEB` — см. [USER_GUIDE §2.2](./USER_GUIDE.md#22-несколько-проектов-в-одном-workspace) |
| `MCP_AGENT_IDENTITY_MODE` | `per_user` | `per_user` или `single_bot` |
| `MCP_OPTIONAL_WORKSPACES` | `false` | создавать ли `backend`, `frontend`, … |
| `MCP_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `MCP_LOG_FILE` | — | путь к файловому sink, например `/var/log/mcp/server.log` |
| `MCP_RL_GLOBAL_RPS` | `20` | глобальный rate limit |
| `MCP_RL_IDENTITY_RPS` | `5` | per-identity rate limit |
| `MCP_ALLOW_CIDR` | `0.0.0.0/0` | список разрешённых CIDR (для прод сужать) |
| `MCP_RETRY_ATTEMPTS` | `3` | retry-budget на 5xx / сетевые ошибки Plane |
| `MCP_RETRY_ATTEMPTS_429` | `10` | отдельный retry-budget на `429 RATE_LIMIT_EXCEEDED`. Plane лимит — per-minute, поэтому 429 ретраится отдельно и щедрее (см. [USER_GUIDE §2.2](./USER_GUIDE.md#22-несколько-проектов-в-одном-workspace) про bootstrap нескольких проектов). Уважает `Retry-After` от Plane, без заголовка — exp. backoff с full-jitter, capped 1–30s. |
| `MCP_RETRY_BACKOFF_MS` | `200` | базовый backoff (5xx — × 2^attempt; 429 — × 2^attempt, capped к 1–30s) |
| `MCP_PLANE_TIMEOUT_MS` | `10000` | таймаут запроса к Plane |
| `MCP_METRICS_ENABLED` | `false` | включить `/metrics` (Prometheus) |
| `MCP_CACHE_MAX_ENTRIES` | `2048` | жёсткий cap на размер `TtlCache` (Plane-ответы read-tools, TTL=10s). При превышении вытесняется самый старый ключ (FIFO). См. [Resource limits for small hosts](#resource-limits-for-small-hosts). |
| `MCP_SESSION_IDLE_MS` | `1800000` (30 мин) | idle-timeout MCP-сессии: если по `mcp-session-id` нет активности дольше этого срока, janitor закрывает сессию и освобождает McpServer + 22 tool-замыкания. |
| `MCP_SESSION_GC_INTERVAL_MS` | `60000` (1 мин) | период фонового janitor'а. `0` отключает периодический sweep (сессии чистятся только на graceful shutdown клиента). |
| `MCP_MAX_SESSIONS` | `256` | жёсткий cap одновременных сессий. При превышении вытесняется самая старая по `lastUsedAt` (LRU). |

### 2.7 Caddy (опц.)

| Переменная | Default | Описание |
|---|---|---|
| `CADDY_DOMAIN` | `slonk.example.com` | основной FQDN |
| `CADDY_MCP_DOMAIN` | `mcp.slonk.example.com` | FQDN для MCP |
| `CADDY_ACME_EMAIL` | — | email для Let's Encrypt |

### 2.8 Backup (опц.)

| Переменная | Default | Описание |
|---|---|---|
| `BACKUP_CRON` | `0 3 * * *` | cron-выражение |
| `BACKUP_RETENTION_DAYS` | `14` | сколько хранить локально |
| `BACKUP_S3_ENDPOINT` | — | внешний S3 endpoint (если есть) |
| `BACKUP_S3_BUCKET` | — | bucket для оффсайт-бэкапов |
| `BACKUP_S3_ACCESS_KEY` | — | **(secret)** |
| `BACKUP_S3_SECRET_KEY` | — | **(secret)** |

### 2.9 Observability (опц.)

| Переменная | Default | Описание |
|---|---|---|
| `GRAFANA_ADMIN_USER` | `admin` | |
| `GRAFANA_ADMIN_PASSWORD` | `change_me` | **(secret)** |
| `PROMETHEUS_RETENTION` | `30d` | retention TSDB |
| `LOKI_RETENTION` | `168h` | retention логов |

## 3. Версии образов

Точные тэги фиксируются здесь и в `docker-compose.yml`. Обновление — отдельный
PR + строка в [CHANGELOG.md](./CHANGELOG.md).

| Сервис | Образ | Тэг |
|---|---|---|
| plane-web | `makeplane/plane-frontend` | `v1.3.0` |
| plane-admin | `makeplane/plane-admin` | `v1.3.0` |
| plane-space | `makeplane/plane-space` | `v1.3.0` |
| plane-live | `makeplane/plane-live` | `v1.3.0` |
| plane-api / plane-worker / plane-beat / plane-migrator | `makeplane/plane-backend` | `v1.3.0` |
| plane-proxy | `makeplane/plane-proxy` | `v1.3.0` |
| postgres | `postgres` | `15.7-alpine` (Plane v1.3.0 testing pin) |
| redis (Valkey) | `valkey/valkey` | `7.2.11-alpine` |
| rabbitmq | `rabbitmq` | `3.13.6-management-alpine` |
| minio | `minio/minio` | `RELEASE.2025-09-07T16-13-09Z` |
| caddy (внешний TLS, Phase 7) | `caddy` | `2.8-alpine` |
| prometheus | `prom/prometheus` | `v2.55.1` |
| grafana | `grafana/grafana` | `11.3.0` |
| loki | `grafana/loki` | `3.3.0` |
| promtail | `grafana/promtail` | `3.3.0` |
| mcp-kanban | локальный build | `slonk/mcp-kanban:dev` локально, `slonk/mcp-kanban:<git-sha>` в релизах |

Тэг `${PLANE_IMAGE_TAG}` (по умолчанию `v1.3.0`) — один на все шесть Plane-образов.
Обновление Plane = один bump переменной + проверка acceptance.

## 4. Bootstrap Plane

Минимальная последовательность (см. [README.md](./README.md#быстрый-старт)):

1. `docker compose up -d`
2. Дождаться `plane-api` healthy.
3. Открыть `http://localhost:3000` → создать первого админа через UI.
4. В UI: Settings → API Tokens → Create → скопировать в `.env: PLANE_API_KEY=...`.
5. `docker compose up -d mcp-kanban` (перезапуск с новым ключом).
6. `docker compose run --rm mcp-kanban bootstrap` — создаст workspace,
   project, states, labels, agent-identities.

Файл `mcp-kanban/bootstrap/manifest.yaml` — единый источник правды для имени
workspace, проекта, состояний, лейблов и identities **для конкретной
установки**. В git он не едет (см. `.gitignore`); в репозитории лежит только
committed-шаблон `manifest.example.yaml`. Workflow по аналогии с
`.env.example → .env`: после `git clone` скопировать
`manifest.example.yaml → manifest.yaml` и править под свой инстанс (добавлять
проекты, менять имена/identifier'ы, корректировать список identities). Loader
сначала ищет `manifest.yaml`, при его отсутствии падает на
`manifest.example.yaml`, поэтому свежий чекаут работает без правок. Подробное
содержимое — в самом файле в репозитории; здесь — структура:

> **Состояния — реконсиляция, а не только досоздание.** Plane v1.3.0 при
> создании проекта заводит дефолтные колонки (`Backlog`, `Todo`,
> `In Progress`, `Done`, `Cancelled`). Bootstrap приводит набор к
> манифесту: совпавшие по имени — оставляет; осиротевший дефолт той же
> `group` переиспользует под манифестное состояние (`Todo` → `To Do`);
> состояния не из манифеста и не `default` — удаляет (`In Progress` и т.п.).
> `default`-состояние не трогается. Повторный прогон → `created: 0,
> renamed: 0, deleted: 0`. Детали — [SPEC.md §5.3](./SPEC.md#53-states-kanban-workflow).

```yaml
workspace:
  slug: agents
  name: "Code Agents"
projects:
  - slug: code-agents
    name: "Code Agents — Default Project"
    identifier: SLONK
    modules: [cycles, modules, views, pages]
states:
  - { name: Backlog,          group: backlog,    color: "#94a3b8", order: 1 }
  - { name: To Do,            group: unstarted,  color: "#3b82f6", order: 2 }
  - { name: Analysis,         group: started,    color: "#a855f7", order: 3 }
  - { name: Development,      group: started,    color: "#22c55e", order: 4 }
  - { name: Security Review,  group: started,    color: "#ef4444", order: 5 }
  - { name: Code Review,      group: started,    color: "#f59e0b", order: 6 }
  - { name: Testing,          group: started,    color: "#06b6d4", order: 7 }
  - { name: Documenting,      group: started,    color: "#0ea5e9", order: 8 }
  - { name: Blocked,          group: started,    color: "#64748b", order: 9 }
  - { name: Done,             group: completed,  color: "#16a34a", order: 10 }
  - { name: Cancelled,        group: cancelled,  color: "#dc2626", order: 11 }
labels:
  - { name: agent-ready,    color: "#3b82f6" }
  - { name: agent-claimed,  color: "#22c55e" }
  - { name: agent-blocked,  color: "#64748b" }
  - { name: needs-human,    color: "#ef4444" }
  - { name: needs-review,   color: "#f59e0b" }
  - { name: needs-tests,    color: "#06b6d4" }
  - { name: bug,            color: "#dc2626" }
  - { name: feature,        color: "#16a34a" }
  - { name: refactoring,    color: "#a855f7" }
  - { name: docs,           color: "#0ea5e9" }
  - { name: infra,          color: "#475569" }
  - { name: security,       color: "#7f1d1d" }
  - { name: high-priority,  color: "#b91c1c" }
  - { name: low-priority,   color: "#94a3b8" }
identities:
  - { role: analyst-agent,         email: analyst-agent@slonk.local,         default_state: Analysis }
  - { role: developer-agent,       email: developer-agent@slonk.local,       default_state: Development }
  - { role: security-auditor-agent,email: security-auditor-agent@slonk.local,default_state: Security Review }
  - { role: code-review-agent,     email: code-review-agent@slonk.local,     default_state: Code Review }
  - { role: qa-agent,              email: qa-agent@slonk.local,              default_state: Testing }
  - { role: doc-agent,             email: doc-agent@slonk.local,             default_state: Documenting }
```

> `projects[].slug` — внутренний ярлык для отчёта bootstrap; Plane его не
> хранит. В MCP проект адресуется по `identifier` (`MCP_DEFAULT_PROJECT` /
> `MCP_ALLOWED_PROJECTS` = `SLONK`), а не по slug.

## 5. Сети и порты

| Порт хоста | Сервис | Когда экспонировать |
|---|---|---|
| `80`, `443` | caddy (внешний, Phase 7) | Прод (если caddy overlay включён) |
| `${PLANE_HOST_PORT}` (default `3000`) | plane-proxy | Базовый compose; единственный front-door без внешнего caddy |
| `8787` | mcp-kanban | Phase 2+ (базовый compose) |
| `5432` | postgres | Только dev-overlay |
| `6379` | redis (Valkey) | Только dev-overlay |
| `5672` | rabbitmq (AMQP) | Только dev-overlay |
| `15672` | rabbitmq (management UI) | Только dev-overlay |
| `9000` | minio (S3 API) | Только dev-overlay |
| `9001` | minio (console) | Только dev-overlay |
| `8000` | plane-api | Только dev-overlay (прямой доступ в обход plane-proxy) |
| `9090` | prometheus | Только obs-overlay |
| `3001` | grafana | Только obs-overlay |

В прод-конфиге публикуется **только** внешний caddy (Phase 7). До Phase 7 — `plane-proxy` на `${PLANE_HOST_PORT}`.

### Resource limits for small hosts

> Цель — не дать одному контейнеру выесть всю RAM маленького хоста и
> столкнуть остальных в swap-thrashing. Лимиты выставлены `mem_limit:` в
> `docker-compose.yml` (compose v2 syntax). На swarm-режиме — не
> применимо, нужны `deploy.resources.limits.memory` (не используем).
>
> **Жёсткий минимум хоста — 4 GB RAM.** На 2 GB суммарный footprint
> Plane backend + worker + frontend'ов + Postgres всё равно не помещается
> (см. [USER_GUIDE §1.1](./USER_GUIDE.md#11-требования)); лимиты ниже —
> baseline под 4 GB.

| Сервис | `mem_limit` | Обоснование |
|---|---|---|
| `postgres` | `512m` | shared_buffers + work_mem + WAL; самый прожорливый. |
| `redis` | `128m` | Plane хранит только сессии/queue-state, не полноценный cache. |
| `rabbitmq` | `256m` | Erlang VM + queues; 192m нестабильно при пиках. |
| `minio` | `192m` | Memory grows linearly with active uploads. |
| `plane-migrator` | `384m` | one-shot Django migrations, лимит для safety. |
| `plane-api` | `512m` | gunicorn worker (`GUNICORN_WORKERS=1`); при >1 — поднимать. |
| `plane-worker` | `384m` | Celery worker. |
| `plane-beat` | `128m` | scheduler-only, minimal footprint. |
| `plane-web` / `admin` / `space` / `live` | `192m` каждый | Next.js SSR; 128m даёт OOM при build cache warmup. |
| `plane-proxy` | `96m` | Caddy reverse-proxy. |
| `mcp-kanban` | `256m` | TtlCache bounded (`MCP_CACHE_MAX_ENTRIES`), MCP-сессии с idle-eviction (`MCP_SESSION_IDLE_MS` + `MCP_MAX_SESSIONS`). |

Итоговая сумма — ~3.3 GB лимитов. На 4 GB хосте остаётся ~700 MB для
ОС и Docker engine — это рабочая полка. Под 8 GB можно поднять лимиты
вдвое (см. ниже).

#### MCP-kanban memory bounds

Помимо `mem_limit:` mcp-kanban имеет приложение-уровневую защиту от
безграничного роста:

- **`TtlCache` (`MCP_CACHE_MAX_ENTRIES`, default 2048).** Read-tools
  кешируют Plane-ответы на 10s. Если уникальных ключей в окне больше
  cap'а — FIFO-эвикция (самый старый вставленный ключ удаляется на `set`).
- **Sequence-id lookup.** `getIssueBySequenceId(SLONK-N)` теперь
  пейджинирует Plane по 50 issue'ов с early-exit'ом, а не тянет
  `?per_page=500` каждый раз. Снижает peak heap на JSON-парсинг.
- **MCP-сессии.** `MCP_SESSION_IDLE_MS` (default 30 мин) + janitor
  `MCP_SESSION_GC_INTERVAL_MS` (default 60s) закрывают сессии,
  переставшие принимать запросы (типичный случай — клиент уронился
  без graceful shutdown). `MCP_MAX_SESSIONS` (default 256) даёт LRU-cap
  на случай шторма уникальных `mcp-session-id`.

Метрики (включаются `MCP_METRICS_ENABLED=1`):

- `mcp_cache_size` — текущий размер `TtlCache`.
- `mcp_cache_evictions_total{reason="ttl"|"cap"}` — счётчик эвикций.
- `mcp_active_sessions` — текущее число MCP-сессий.
- `mcp_sessions_evicted_total{reason="idle"|"cap"}` — счётчик эвикций
  сессий.

#### Тюнинг под другие хосты

- **2 GB RAM.** Не пытайся — Plane backend сам по себе не помещается.
- **4 GB RAM.** Baseline-цифры выше.
- **8 GB RAM.** Можно удвоить `postgres → 1g`, `plane-api → 1g`,
  `plane-worker → 768m`, остальные оставить. Это даёт головному
  worker'у Plane дышать на пиках (миграции, mass-update).
- **16+ GB RAM.** `mem_limit` всё ещё полезен (защита от unbounded
  growth bug'ов в upstream), но цифры можно умножить на 2–4. Альтернатива
  — `mem_reservation` (soft-лимит) + `mem_limit` ×2 от него.

Проверка применения лимитов:

```bash
docker compose config | yq '.services[] | {name: .container_name // .image, mem_limit}'
# или просто:
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}'
```

## 6. Подключение агентов

Общий контракт: `ALL /mcp` (StreamableHTTP), Bearer-токен в `Authorization`,
identity в `X-Agent-Identity` (одна из ролей bootstrap'а: по умолчанию
`analyst-agent`, `developer-agent`, `security-auditor-agent`,
`code-review-agent`, `qa-agent`, `doc-agent`, `merger-agent`). Whitelist
собирается рантайм-овым `IdentityRegistry` из `identity.sqlite` (после
`make bootstrap`) с fallback на `bootstrap/manifest.yaml`, поэтому добавить
свою роль = поправить `identities:` в манифесте и пере-bootstrap'нуть —
правки кода не нужны (см. [SPEC.md §5.5](./SPEC.md#55-agent-identity)).
URL — `http://localhost:8787/mcp` в dev, `https://mcp.slonk.example.com/mcp`
в прод через caddy (Phase 7).

### 6.1 Claude Code

Claude Code поддерживает HTTP MCP нативно. Самый простой способ — CLI:

```bash
claude mcp add --transport http slonk http://localhost:8787/mcp \
  --header "Authorization: Bearer $MCP_AUTH_TOKEN" \
  --header "X-Agent-Identity: developer-agent"
```

По умолчанию запись попадает в пользовательский конфиг (`~/.claude.json`).
Для project-scope добавьте `--scope project` — Claude Code запишет
`.mcp.json` в корень репо, который коммитится без секретов:

```jsonc
{
  "mcpServers": {
    "slonk": {
      "type": "http",
      "url": "http://localhost:8787/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_AUTH_TOKEN}",
        "X-Agent-Identity": "developer-agent"
      }
    }
  }
}
```

`${MCP_AUTH_TOKEN}` подставляется из окружения, в которой запущен
`claude` (например, из `direnv` или `~/.claude/.env`).

### 6.2 Claude Desktop

В UI: **Settings → Connectors → Add custom connector**, URL
`http://localhost:8787/mcp`, заголовки `Authorization: Bearer …` и
`X-Agent-Identity: developer-agent`. Это самый чистый путь для актуальных
версий Claude Desktop.

Через конфиг-файл
(`~/Library/Application Support/Claude/claude_desktop_config.json` на macOS,
`%APPDATA%\Claude\claude_desktop_config.json` на Windows) — Claude Desktop
по конфигу поддерживает stdio-MCP, поэтому HTTP-сервер обёртывается
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```jsonc
{
  "mcpServers": {
    "slonk": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "http://localhost:8787/mcp",
        "--header", "Authorization: Bearer ${MCP_AUTH_TOKEN}",
        "--header", "X-Agent-Identity: developer-agent"
      ],
      "env": { "MCP_AUTH_TOKEN": "..." }
    }
  }
}
```

После правки конфига — полный перезапуск Claude Desktop (Quit, не закрытие окна).

### 6.3 Codex CLI (OpenAI)

Codex CLI читает `~/.codex/config.toml`; MCP-сервера в нём работают через
stdio, для HTTP slonk оборачиваем через тот же `mcp-remote`:

```toml
[mcp_servers.slonk]
command = "npx"
args = [
  "-y", "mcp-remote",
  "http://localhost:8787/mcp",
  "--header", "Authorization: Bearer ${MCP_AUTH_TOKEN}",
  "--header", "X-Agent-Identity: developer-agent",
]

[mcp_servers.slonk.env]
MCP_AUTH_TOKEN = "..."
```

Когда в slonk появится встроенный stdio-режим (`mcp-kanban stdio …` — пока
не реализовано, см. [SPEC.md §6.1](./SPEC.md#61-транспорт-и-аутентификация)),
bridge через `mcp-remote` можно будет убрать.

### 6.4 Кастомные MCP-клиенты

Любой клиент, говорящий MCP-over-HTTP (StreamableHTTP, MCP SDK ≥ 1.29),
подключается напрямую. Минимум:

- Заголовок `Authorization: Bearer <MCP_AUTH_TOKEN>`.
- Заголовок `X-Agent-Identity: <role>` (одна из identities из bootstrap).
- Сессия идентифицируется заголовком `mcp-session-id`, который сервер
  возвращает на `initialize` и ожидает в последующих запросах.

Диагностика: `GET /mcp/tools` (Bearer, identity не обязательна) вернёт
список зарегистрированных tool'ов.

## 7. Обратный прокси и TLS

`caddy/Caddyfile` (шаблон):

```caddy
{
  email {$CADDY_ACME_EMAIL}
}

{$CADDY_DOMAIN} {
  encode zstd gzip
  reverse_proxy plane-web:3000
  @api path /api/* /spaces/* /admin/*
  reverse_proxy @api plane-api:8000
}

{$CADDY_MCP_DOMAIN} {
  encode zstd gzip
  reverse_proxy mcp-kanban:8787
  # MCP требует поддержки SSE; Caddy умеет это «из коробки»
}
```

ACME-сертификаты живут в `caddy_data`. Для on-prem без публичного DNS — внутренний
CA + локальные сертификаты (см. документацию Caddy `tls internal`).

## 8. Observability

Включается overlay'ем `docker-compose.obs.yml`. Минимум:

- Prometheus собирает `mcp-kanban:8787/metrics` (если `MCP_METRICS_ENABLED=true`)
  и `node_exporter` (опционально).
- Promtail тейлит stdout всех контейнеров через docker-socket и пушит в Loki.
- Grafana провижится с дашбордом `slonk-overview` (preset, лежит в
  `grafana/provisioning/dashboards/`).

Доступ к Grafana — через caddy с basic-auth: `/grafana` → `grafana:3000`.

## 9. Backup

Сервис `backup` запускает раз в `BACKUP_CRON`:

```bash
pg_dump -Fc -h postgres -U $POSTGRES_USER $POSTGRES_DB \
  > /backup/postgres-$(date +%F).dump

mc alias set local http://minio:9000 $MINIO_ROOT_USER $MINIO_ROOT_PASSWORD
mc mirror --overwrite local/plane /backup/minio-plane-$(date +%F)
mc mirror --overwrite local/mcp /backup/minio-mcp-$(date +%F)

tar czf /backup/mcp_data-$(date +%F).tgz /mcp_data
```

Чистка старого — `find /backup -mtime +$BACKUP_RETENTION_DAYS -delete`.

При наличии `BACKUP_S3_ENDPOINT` — после локального дампа `mc cp` всё в внешний S3.

### Восстановление из бэкапа

```bash
# 1. Остановить стек
docker compose down

# 2. Восстановить Postgres
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U plane -d plane < backup/postgres-2026-05-10.dump

# 3. Восстановить MinIO
docker compose up -d minio
docker compose exec backup mc mirror /backup/minio-plane-2026-05-10 local/plane
docker compose exec backup mc mirror /backup/minio-mcp-2026-05-10 local/mcp

# 4. Восстановить MCP SQLite
tar xzf backup/mcp_data-2026-05-10.tgz -C /

# 5. Поднять остальное
docker compose up -d
```

## 10. Профили compose

| Профиль | Сервисы | Когда включать |
|---|---|---|
| (default) | plane-*, postgres, redis, rabbitmq, minio, mcp-kanban | всегда |
| `proxy` | caddy | прод |
| `obs` | prometheus, grafana, loki, promtail | по желанию |
| `backup` | backup | рекомендуется в проде |
| `dev` | (overlay docker-compose.dev.yml) | публикует БД/MinIO на хост для отладки |

## 11. Чек-лист первого запуска

- [ ] `.env` создан, все `change_me` заменены.
- [ ] `docker compose config` валиден.
- [ ] `docker compose up -d` поднимает все сервисы; `docker compose ps` показывает healthy.
- [ ] Plane UI открывается; создан admin.
- [ ] `PLANE_API_KEY` записан в `.env`, MCP перезапущен.
- [ ] `bootstrap` отработал без ошибок (вывод заканчивается `BOOTSTRAP OK`).
- [ ] `curl /health` MCP и Plane возвращают 200.
- [ ] Claude Code видит инструменты MCP (`/mcp` в CLI).
- [ ] Тестовый `claim_issue` отрабатывает.
