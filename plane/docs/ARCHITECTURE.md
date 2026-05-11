# Архитектура — slonk

## 1. Обзор

slonk — это монолитный single-tenant стек на одном docker-хосте. Состоит из
неизменяемого Plane upstream + собственного MCP-сервера + инфраструктурных
сервисов (Postgres, Redis, RabbitMQ, MinIO). Опционально — обратный прокси с
TLS и observability/backup-стек.

```text
                       ┌──────────────────────────────────────────┐
                       │              Хост (Docker)               │
                       │                                          │
  browser ────TLS───┐  │  ┌───────┐    ┌─────────────┐            │
  (Plane UI)        ├──┼─▶│ caddy │───▶│ plane-proxy │ (path fan-out)
                    │  │  └───┬───┘    └──────┬──────┘            │
                    │  │      │               ├──▶ plane-web      │
                    │  │      │               ├──▶ plane-admin    │
                    │  │      │               ├──▶ plane-space    │
                    │  │      │               ├──▶ plane-live     │
                    │  │      │               ├──▶ plane-api ───┐ │
                    │  │      │               └──▶ minio        │ │
  MCP client ───────┘  │      └───────────▶ mcp-kanban ◀────────┘ │
  (Claude / Codex)     │                          │               │
                       │                          ▼               │
                       │             ┌──────────────────────┐     │
                       │             │  plane-api (REST)    │     │
                       │             └──────────┬───────────┘     │
                       │                        │                 │
                       │   ┌──────────┬─────────┼─────────┐       │
                       │   ▼          ▼         ▼         ▼       │
                       │ postgres   redis   rabbitmq   minio      │
                       │   (Valkey)                               │
                       │   + plane-worker, plane-beat, migrator   │
                       └──────────────────────────────────────────┘
```

`caddy` (Phase 7) — внешний TLS-шлюз. `plane-proxy` (Phase 1) — внутренний
fan-out по path-префиксам, требуется upstream Plane v1.3.0.

## 2. Логические слои

| Слой | Сервисы | Ответственность |
|---|---|---|
| Edge | `caddy` (опц.) | TLS, HTTP routing, basic auth для observability |
| Application | `plane-web`, `plane-api`, `plane-worker`, `plane-beat`, `mcp-kanban` | Бизнес-логика |
| Data | `postgres`, `redis`, `rabbitmq`, `minio` | Состояние |
| Observability | `prometheus`, `grafana`, `loki`, `promtail` (опц.) | Метрики, логи, дашборды |
| Maintenance | `backup` (опц.) | Регулярные снапшоты |

## 3. Сетевая топология

Два docker-network'а:

### 3.1 `public_net`

Bridge-сеть, через которую разрешён трафик с хоста (а через внешний caddy —
и извне). На ней живут только публикуемые наружу сервисы:

- `plane-proxy` (Phase 1, базовый compose) — публикует `${PLANE_HOST_PORT}:80`
  (default `3000:80`). Единственный front-door всего стека Plane.
- `mcp-kanban` (Phase 2+) — публикует `${MCP_SERVER_PORT}:8787` для агентов.
- Внешний `caddy` (Phase 7, overlay `--profile proxy`) перехватывает `:80`/`:443`
  и проксирует на `plane-proxy` + `mcp-kanban`.

### 3.2 `internal_net`

Bridge-сеть без публикации портов на хост в базовом compose. На ней живут:

- Данные: `postgres`, `redis`, `rabbitmq`, `minio` — exclusive.
- Plane backend: `plane-api`, `plane-worker`, `plane-beat`, `plane-migrator` —
  exclusive (наружу выходят через `plane-proxy`).
- Plane frontends: `plane-web`, `plane-admin`, `plane-space`, `plane-live` —
  exclusive.
- `mcp-kanban` — оба network'а (наружу для агентов, внутрь для Plane API).
- `plane-proxy` — оба network'а (наружу для пользователей, внутрь для
  fan-out по plane-web/api/admin/space/live/minio).

В dev-overlay (`docker-compose.dev.yml`) на хост дополнительно публикуются:
`postgres:5432`, `redis:6379`, `rabbitmq:5672` + `:15672` (management),
`minio:9000` + `:9001` (console), `plane-api:8000`. В прод-режиме эти
порты остаются изолированными в `internal_net`.

### 3.3 Hostname'ы

Внутри docker — стандартные service-name'ы. MCP резолвит:

- `http://plane-api:8000` — Plane REST API.
- `http://minio:9000` — S3 endpoint.

Снаружи — через `caddy` (`https://slonk.example.com` → `plane-web`,
`https://mcp.slonk.example.com` → `mcp-kanban`) либо напрямую на dev-порты.

## 4. Контейнеры и сервисы

Точные образы и версии — [CONFIGURATION.md](./CONFIGURATION.md#версии-образов).

| Сервис | Базовый образ | Restart | Зависимости |
|---|---|---|---|
| `plane-proxy` | `makeplane/plane-proxy:v1.3.0` | `unless-stopped` | `plane-web`, `plane-api`, `plane-admin`, `plane-live`, `plane-space` |
| `plane-web` | `makeplane/plane-frontend:v1.3.0` | `unless-stopped` | `plane-api` (healthy) |
| `plane-admin` | `makeplane/plane-admin:v1.3.0` | `unless-stopped` | `plane-api` (healthy) |
| `plane-space` | `makeplane/plane-space:v1.3.0` | `unless-stopped` | `plane-api` (healthy) |
| `plane-live` | `makeplane/plane-live:v1.3.0` | `unless-stopped` | `plane-api` (healthy), `redis` |
| `plane-api` | `makeplane/plane-backend:v1.3.0` | `unless-stopped` | `postgres`, `redis`, `rabbitmq`, `minio` (все healthy), `plane-migrator` (completed) |
| `plane-worker` | `makeplane/plane-backend:v1.3.0` | `unless-stopped` | `plane-api`, `plane-migrator` |
| `plane-beat` | `makeplane/plane-backend:v1.3.0` | `unless-stopped` | `plane-api`, `plane-migrator` |
| `plane-migrator` | `makeplane/plane-backend:v1.3.0` | `"no"` (one-shot) | `postgres`, `redis` (healthy) |
| `postgres` | `postgres:15.7-alpine` | `unless-stopped` | — |
| `redis` | `valkey/valkey:7.2.11-alpine` | `unless-stopped` | — |
| `rabbitmq` | `rabbitmq:3.13.6-management-alpine` | `unless-stopped` | — |
| `minio` | `minio/minio:RELEASE.2025-09-07T16-13-09Z` | `unless-stopped` | — |
| `mcp-kanban` | локальный build из `mcp-kanban/` | `unless-stopped` | `plane-api` |
| `caddy` | `caddy:2-alpine` | `unless-stopped` | `plane-proxy`, `mcp-kanban` |
| `prometheus` | `prom/prometheus:v2` | `unless-stopped` | — |
| `grafana` | `grafana/grafana:11` | `unless-stopped` | `prometheus`, `loki` |
| `loki` | `grafana/loki:3` | `unless-stopped` | — |
| `promtail` | `grafana/promtail:3` | `unless-stopped` | `loki` |
| `backup` | локальный slim alpine + `pg_dump`, `mc` | `unless-stopped` | — |

Все pinned образы и тэги — обязательно явные (никаких `:latest`).

**Plane backend под капотом — один образ.** Сервисы `plane-api`, `plane-worker`,
`plane-beat`, `plane-migrator` поднимаются из одного и того же
`makeplane/plane-backend:v1.3.0`; различаются только командой entrypoint'а
(`docker-entrypoint-{api,worker,beat,migrator}.sh`).

**plane-proxy — обязательный front-door, не опциональный.** Фронтенды Plane
(`plane-web`/`plane-admin`/`plane-space`) собраны со same-origin routing —
все XHR-вызовы идут на текущий origin с path-префиксами (`/api/*`,
`/god-mode/*`, `/spaces/*`, `/live/*`, `/${BUCKET_NAME}/*`). Без plane-proxy
фронтенды не работают. В Phase 7 поверх plane-proxy ставится внешний `caddy`
для TLS и публичного DNS.

**Network-aliases для plane-proxy.** Bundled Caddyfile внутри `plane-proxy`
жёстко ссылается на hostname'ы `api`, `web`, `admin`, `space`, `live`,
`plane-minio`. Наши сервисы в compose именуются по конвенции (`plane-api`,
`plane-web`, …); внутри `internal_net` для них прописаны network-aliases,
чтобы Caddy резолвил backends без модификации образа.

Healthchecks:

- `plane-api`: `python3 -c "import urllib.request,sys; sys.exit(0) if urllib.request.urlopen('http://localhost:8000/', timeout=3).status==200 else sys.exit(1)"`
  (upstream Plane не отдаёт `/api/v1/health`; работающий health-эндпоинт — `GET /` → `{"status":"OK"}`).
- `plane-web` / `plane-admin`: `curl -fsS http://127.0.0.1:3000/` (встроены в Dockerfile upstream).
- `plane-space`: `curl -fsS http://127.0.0.1:3000/spaces/` (встроен в Dockerfile upstream).
- `plane-live`: `wget -qO- http://localhost:3000/live/`.
- `plane-proxy`: `wget -qO- http://localhost:80/`.
- `plane-worker` / `plane-beat`: healthcheck не настроен, полагаемся на `restart: unless-stopped`.
- `plane-migrator`: one-shot; используется `depends_on: condition: service_completed_successfully`.
- `mcp-kanban`: `wget -qO- http://localhost:8787/health`.
- `postgres`: `pg_isready -U $POSTGRES_USER -d $POSTGRES_DB`.
- `redis` (Valkey): `valkey-cli ping`.
- `rabbitmq`: `rabbitmq-diagnostics -q ping`.
- `minio`: `curl -fsS http://localhost:9000/minio/health/live`.

`depends_on` использует `condition: service_healthy` для длительных сервисов и
`condition: service_completed_successfully` для one-shot `plane-migrator`.

## 5. Volumes

| Volume | Сервис | Размер (план) | Что внутри |
|---|---|---|---|
| `postgres_data` | postgres | ~5 GB / 10k issues | основная БД Plane |
| `redis_data` | redis | ~50 MB | AOF/RDB |
| `rabbitmq_data` | rabbitmq | ~100 MB | очереди |
| `minio_data` | minio | по объёму вложений | S3 buckets `plane`, `mcp` |
| `plane_uploads` | plane-api/worker | резерв, обычно пуст | локальные uploads, если S3 выключен |
| `mcp_data` | mcp-kanban | < 100 MB | SQLite (audit, git_refs, agent_identity) |
| `mcp_logs` | mcp-kanban | rotate | файловые JSON-логи |
| `caddy_data` | caddy | < 50 MB | сертификаты ACME |
| `caddy_config` | caddy | < 5 MB | autosaved config |
| `prometheus_data` | prometheus | ~1 GB / 30d retention | TSDB |
| `grafana_data` | grafana | ~50 MB | дашборды/пользователи |
| `loki_data` | loki | ~2 GB / 7d retention | индекс + chunks |
| `backup_data` | backup | по политике | дампы и tar-архивы |

Имена volume'ов фиксированы; `docker compose down -v` — единственный способ
полностью обнулить состояние.

## 6. Поток данных

### 6.1 Чтение задач агентом

```text
agent → MCP.list_issues({state:"To Do", limit:50})
        MCP → Plane GET /workspaces/agents/projects/code-agents/issues/?state=...&limit=50
        Plane → Postgres SELECT
        Plane → MCP   (200, JSON)
        MCP → agent  (нормализованный список + extracted meta-блок)
```

### 6.2 Claim задачи

```text
agent → MCP.claim_issue({issue_id:"SLONK-123"})
        MCP начинает транзакцию аудита (begin trace_id)
        MCP → Plane GET issue
        MCP проверяет лейблы (no "agent-claimed" другого агента)
        MCP → Plane PATCH issue:
              - assignees += [identity.plane_user_id]
              - labels += ["agent-claimed"]
              - state = role-default (Analysis/Development/...)
        MCP → Plane POST comment "[role]: claimed"
        MCP → SQLite INSERT audit_log
        MCP → agent (issue, обновлённый)
```

При гонке двух claim — выигрывает тот, чей PATCH к Plane прошёл первым;
второй получает у Plane объект с уже стоящим `agent-claimed` и MCP отвечает
`CONFLICT`.

### 6.3 Прикрепление файла

```text
agent → MCP.attach_file({issue_id, filename, mime, size})
        MCP → MinIO presign PUT
        MCP → agent (presigned URL)
agent → PUT file → MinIO
agent → MCP.attach_file_complete({issue_id, object_key})
        MCP → Plane POST attachment metadata
        MCP → agent (success)
```

### 6.4 Webhooks (Phase 6+, не v1)

Если включить webhooks в Plane → `mcp-kanban` принимает их на
`POST /webhooks/plane` (HMAC-подпись), и применяет реакции: например, при
переходе в `Done` дёргает агента-документатора через очередь задач.

## 7. Состояния и переходы (canonical workflow)

```text
Backlog
  └─▶ To Do
        ├─▶ Analysis ─────▶ Development ─▶ Security Review ─▶ Code Review ─▶ Testing ─▶ Documenting ─▶ Done
        │       │                │                │                │             │              │
        │       └──▶ Blocked     └──▶ Blocked     └──▶ Blocked     └──▶ Blocked  └──▶ Blocked   └──▶ Cancelled
        └─▶ Cancelled
```

Разрешённые «обратные» переходы (`gsd`-style):

- `Code Review → Development` (правки по ревью).
- `Testing → Development` (нашлись баги).
- `Documenting → Development` (вскрылась дыра в коде при документировании).
- `Blocked → <предыдущее started>` (разблокировалось).

Все переходы возможны через `transition_issue`; MCP не блокирует «нелегальные»
переходы для v1, но логирует их и помечает лейблом `workflow-warning`.

## 8. Failure modes & recovery

| Сценарий | Поведение |
|---|---|
| Plane API недоступен | MCP отвечает `PLANE_UNAVAILABLE`, `/health` показывает `plane_reachable:false` |
| Postgres упал | Plane-api перестаёт принимать запросы → restart по unhealthy → восстанавливается |
| MinIO упал | `attach_file` отвечает `INTERNAL`, остальные tools работают |
| RabbitMQ упал | Plane-worker без очередей; чтение через API продолжает работать |
| MCP упал | Plane UI продолжает работать; агенты получают connection refused |
| Хост перезагружен | `restart: unless-stopped` поднимает всё в правильном порядке через healthcheck'и |
| Том повреждён | Восстанавливаемся из `backup_data` — см. [CONFIGURATION.md](./CONFIGURATION.md#восстановление-из-бэкапа) |

## 9. Модель угроз

| Угроза | Митигация |
|---|---|
| Утечка `MCP_AUTH_TOKEN` | Rotation через `.env` + `docker compose up -d mcp-kanban`; токены не логируются |
| Скомпрометированный агент пишет в чужие задачи | Один проект `code-agents` — scope ограничен; для расширения нужны явные `MCP_ALLOWED_PROJECTS` |
| Внешний доступ к Postgres | `internal_net` без публикации портов |
| MITM на API | Caddy + ACME-сертификат для прод |
| Prompt injection через комментарий | MCP не исполняет инструкции из контента issue, только из MCP-вызовов |
| DoS на MCP | Rate limit per-identity + глобальный |
| Удаление данных через UI | Plane сам по себе не имеет иммутабельного режима; защита — бэкапы |
| Перезапись `meta`-блока | Идемпотентный writer + лейбл `needs-human` при коррупции |

## 10. Расширяемость

Точки расширения, заложенные архитектурой:

- **Multi-project**: добавить проект в bootstrap-manifest, MCP читает список из
  `MCP_ALLOWED_PROJECTS`.
- **Per-repo агенты**: дополнительные роли = новые agent-identities + bootstrap.
- **Webhook reactions**: новый `mcp-reactor` сервис с очередью на RabbitMQ.
- **Альтернативный backend**: за счёт абстракции `IssueTrackerClient` в коде
  MCP — потенциальная замена Plane на Linear/Jira без смены MCP-tools-API.
- **HA**: для v2 — Postgres replica + два MCP за load balancer + Redis Sentinel.
  Не входит в v1.
