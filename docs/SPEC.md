# Техническая спецификация — slonk

Документ описывает технические требования к реализации self-hosted task-tracker
для LLM-агентов на базе Plane + собственного MCP-сервера. Всё, что зафиксировано
здесь, считается контрактом — изменения через PR + запись в [CHANGELOG.md](./CHANGELOG.md).

## 1. Цели и не-цели

### 1.1 Цели

- Дать MCP-совместимым агентам (Claude Code, Codex, прочие) единый интерфейс для
  работы с канбан-доской: чтение backlog, заявка на задачу, смена статусов,
  комментарии, прикрепление артефактов, связь с git.
- Сохранить полную историю действий агентов и человеческих участников.
- Развёртывание одной командой `docker compose up -d` + bootstrap-скрипт.
- Персистентность всех данных между перезапусками контейнеров.
- Жёсткое разграничение «снаружи» (`public_net`) и «внутри» (`internal_net`).

### 1.2 Не-цели

- Реализация собственного канбана. Plane используется как есть.
- Поддержка SaaS / multi-tenant. Один инстанс — одна команда.
- Прямой коннект агентов к Plane API в обход MCP.
- Высокая доступность / horizontal scaling. Для v1 достаточно single-node.

## 2. Глоссарий

| Термин | Значение |
|---|---|
| **Plane** | Self-hosted issue tracker, источник правды по задачам |
| **MCP** | Model Context Protocol — стандарт инструментов для LLM-агентов |
| **MCP Server** | Наш сервис, экспонирующий Plane через MCP-протокол |
| **Workspace** | Контейнер Plane верхнего уровня (организация) |
| **Project** | Подразделение workspace, содержит issues |
| **Issue / Work item** | Задача |
| **State** | Статус задачи (Backlog, To Do, Development, …) |
| **Cycle** | Спринт в терминах Plane |
| **Module** | Эпик / крупная инициатива в терминах Plane |
| **Agent identity** | Цифровая идентичность конкретной роли агента |
| **Bootstrap** | Идемпотентная инициализация workspace/project/states/labels |

## 3. Архитектура (резюме)

Подробно — [ARCHITECTURE.md](./ARCHITECTURE.md).

```text
                         public_net
┌──────────────────────────────────────────────────────────┐
│  agent → reverse-proxy → plane-web (UI)                  │
│                       → plane-api (REST)                 │
│                       → mcp-kanban (MCP HTTP/SSE)        │
└──────────────────────────────────────────────────────────┘
                                │
                                ▼
                         internal_net
┌──────────────────────────────────────────────────────────┐
│ plane-api │ plane-worker │ plane-beat │ mcp-kanban       │
│        ↓        ↓             ↓             ↓            │
│   postgres   redis      rabbitmq         minio           │
└──────────────────────────────────────────────────────────┘
```

## 4. Компоненты

### 4.1 Plane

- Образы и версии — пин в `docker-compose.yml` (см. [CONFIGURATION.md](./CONFIGURATION.md)).
- Используем upstream-образы Plane без модификаций.
- API-ключ создаётся через UI и кладётся в `.env` как `PLANE_API_KEY`.
- Webhook'ов для v1 не настраиваем (опционально с Phase 6 — см. [ROADMAP.md](./ROADMAP.md)).

### 4.2 MCP Server

Отдельный контейнер. Контракт:

- Один процесс, без воркеров (для v1).
- HTTP + Server-Sent Events транспорт MCP на `MCP_SERVER_PORT` (по умолчанию `8787`).
- Опциональный stdio-режим для локального запуска без Docker.
- Bearer-аутентификация по `MCP_AUTH_TOKEN`.
- Stateless относительно агентов; никакого session storage кроме кеша Plane-ответов.
- Локальный SQLite-стор для:
  - таблицы соответствия `mcp_agent_identity → plane_user_id`;
  - таблицы связей `issue_id → git_refs[]` (репо/ветка/PR/коммит);
  - таблицы аудита действий MCP (см. §6.7).
- Сторонние библиотеки определены в [CONVENTIONS.md](./CONVENTIONS.md#стек-mcp-server).

### 4.3 Persistence

| Том | Назначение |
|---|---|
| `postgres_data` | БД Plane |
| `redis_data` | Кеш / очереди Plane |
| `rabbitmq_data` | Очереди задач Plane |
| `minio_data` | Файловое хранилище (вложения, экспорты) |
| `plane_uploads` | Локальные uploads Plane, если не уходят в MinIO |
| `mcp_data` | SQLite + кеш MCP |
| `mcp_logs` | Файловые логи MCP, если включён файловый sink |

## 5. Plane: данные и bootstrap

Bootstrap выполняется командой `docker compose run --rm mcp-kanban bootstrap`.
Скрипт идемпотентен: повторный запуск не дублирует сущности, а догоняет
недостающие. Все имена workspace/project/state/label берутся из `.env` и
встроенного `bootstrap/manifest.yaml` MCP-сервера.

### 5.1 Workspace

Обязательный workspace: `agents` (slug настраивается через `MCP_DEFAULT_WORKSPACE`).

Опциональные workspaces, создаются если `MCP_OPTIONAL_WORKSPACES=true`:
`backend`, `frontend`, `infra`, `research`, `qa`.

### 5.2 Project

В `agents` создаётся проект «Code Agents — Default Project» с identifier
`SLONK`. На него указывают `MCP_DEFAULT_PROJECT` / `MCP_ALLOWED_PROJECTS`
(Plane-проекты не имеют отдельного slug — адресуем по identifier).

В проекте включены модули: cycles, modules, views, pages.

### 5.3 States (kanban workflow)

| State | Group | Назначение |
|---|---|---|
| `Backlog` | backlog | Сырая задача |
| `To Do` | unstarted | Готова к работе агентом |
| `Analysis` | started | Агент-аналитик ведёт задачу |
| `Development` | started | Агент-разработчик ведёт задачу |
| `Security Review` | started | Агент-аудитор безопасности |
| `Code Review` | started | Агент-ревьюер |
| `Testing` | started | Агент-тестер |
| `Documenting` | started | Агент-документатор |
| `Blocked` | started | Заблокировано (ждём фидбек) |
| `Done` | completed | Завершено |
| `Cancelled` | cancelled | Отменено |

Порядок обязательный — bootstrap создаёт states в этом порядке.

### 5.4 Labels

Обязательные labels проекта `SLONK` (с фиксированной палитрой —
см. `bootstrap/manifest.yaml`):

`agent-ready`, `agent-claimed`, `agent-blocked`, `needs-human`, `needs-review`,
`needs-tests`, `bug`, `feature`, `refactoring`, `docs`, `infra`, `security`,
`high-priority`, `low-priority`.

### 5.5 Agent identity

Один Plane-пользователь на роль агента. Аккаунты создаются bootstrap-скриптом:

| Identity | Email | Plane-role в workspace |
|---|---|---|
| `analyst-agent` | `analyst-agent@slonk.local` | Member |
| `developer-agent` | `developer-agent@slonk.local` | Member |
| `security-auditor-agent` | `security-auditor-agent@slonk.local` | Member |
| `code-review-agent` | `code-review-agent@slonk.local` | Member |
| `qa-agent` | `qa-agent@slonk.local` | Member |
| `doc-agent` | `doc-agent@slonk.local` | Member |

Если в текущей версии Plane создание пользователей через API запрещено или
ограничено, MCP **должен** использовать единого бота `agents-bot@slonk.local` и
помечать каждое действие через:

1. Префикс комментариев — `[analyst-agent]: …`.
2. Лейбл `claimed-by:<role>` (создаётся динамически).
3. Запись в SQLite-стор MCP — для аудита.

Выбор стратегии (per-user vs single-bot) — параметр `MCP_AGENT_IDENTITY_MODE`
(`per_user` | `single_bot`). По умолчанию `per_user`, fallback на `single_bot`
если bootstrap не смог создать пользователей.

### 5.6 Привязка к репозиториям

Plane не имеет первоклассного поля «репозиторий/ветка/PR». Связи хранятся:

1. **Описание задачи** — машинно-читаемый блок в конце:

   ```text
   ---
   <!-- slonk:meta v1 -->
   repos:
     - url: https://github.com/acme/backend
       branch: feature/SLONK-123-auth-flow
       pr: https://github.com/acme/backend/pull/456
       commits:
         - 4f1a2b3
   ```

2. **Локальный стор MCP** (`mcp_data/git_refs.sqlite`) — индекс для быстрого поиска.

3. **Комментарии задачи** — событийный лог: «открыт PR …», «добавлен коммит …».

Парсинг блока — строгий YAML после маркера `<!-- slonk:meta v1 -->`. Если блок
повреждён, MCP логирует ошибку и не разрушает описание — пишет валидный блок
рядом и помечает задачу лейблом `needs-human`.

## 6. MCP Server: API

### 6.1 Транспорт и аутентификация

- HTTP+SSE: единый endpoint `ALL /mcp` через `StreamableHTTPServerTransport`
  (MCP SDK ≥ 1.29). POST принимает JSON-RPC, GET апгрейдится в SSE-стрим.
  Сессия идентифицируется заголовком `mcp-session-id`, который сервер
  возвращает на `initialize` и ожидает в последующих запросах.
- `GET /mcp/tools` — диагностический endpoint, возвращает список имён
  зарегистрированных tool'ов (Bearer-авторизация, identity не обязательна).
- stdio: `mcp-kanban stdio` для локального запуска (в v1 не реализован).
- Auth: `Authorization: Bearer <MCP_AUTH_TOKEN>` для всех HTTP-эндпоинтов
  кроме `/health`.
- В заголовке `X-Agent-Identity: <role>` агент сообщает свою роль. Если заголовок
  отсутствует на `/mcp` — MCP вернёт 401 `IDENTITY_REQUIRED`.
- `GET /health` — без авторизации, возвращает
  `{status, service, version, plane_reachable, plane_status, plane_latency_ms}`.

### 6.2 Перечень инструментов

| Tool | Назначение |
|---|---|
| `list_workspaces` | Список доступных workspaces |
| `list_projects` | Список проектов workspace |
| `list_states` | Состояния проекта (для UI/выбора при transition) |
| `list_labels` | Лейблы проекта |
| `list_cycles` | Активные/прошедшие циклы (sprints) |
| `list_modules` | Модули (epics) |
| `list_issues` | Поиск задач по фильтрам |
| `get_issue` | Полные детали задачи + meta-блок + связи |
| `search_issues` | Полнотекстовый поиск по title/description/comments |
| `create_issue` | Создать новую задачу |
| `update_issue` | Изменить поля (title, description, priority, assignees, labels) |
| `transition_issue` | Перевести задачу в новый state |
| `claim_issue` | Атомарно: assign себе + state `Analysis`/`Development` + label `agent-claimed` |
| `release_issue` | Снять с себя + state `To Do` + remove `agent-claimed` |
| `block_issue` | state `Blocked` + label `agent-blocked` + комментарий с причиной |
| `comment_issue` | Добавить комментарий (с префиксом identity) |
| `attach_file` | Загрузить файл к задаче (через MinIO presigned upload) |
| `link_git_ref` | Добавить запись в meta-блок: repo/branch/pr/commit |
| `unlink_git_ref` | Удалить связь |
| `find_issues_by_git_ref` | Найти issues по repo/branch/pr/commit (SQLite-индекс, без обращения к Plane) |
| `get_issue_history` | История действий по задаче (Plane activity + MCP audit) |
| `who_am_i` | Вернуть текущую identity и её права |

### 6.3 Схемы параметров

Все tools используют JSON Schema; полные схемы — в `mcp-kanban/schemas/`.
Ключевые контракты:

`claim_issue`

```json
{
  "type": "object",
  "required": ["issue_id"],
  "properties": {
    "issue_id":   { "type": "string", "description": "Plane issue ID или sequence_id (PROJ-123)" },
    "target_state": {
      "type": "string",
      "enum": ["Analysis", "Development", "Security Review", "Code Review", "Testing", "Documenting"],
      "description": "По умолчанию выбирается по identity"
    }
  }
}
```

`transition_issue`

```json
{
  "type": "object",
  "required": ["issue_id", "state"],
  "properties": {
    "issue_id": { "type": "string" },
    "state":    { "type": "string", "description": "Имя или ID state" },
    "comment":  { "type": "string", "description": "Необязательный комментарий перехода" }
  }
}
```

`link_git_ref`

```json
{
  "type": "object",
  "required": ["issue_id", "repo_url"],
  "properties": {
    "issue_id": { "type": "string" },
    "repo_url": { "type": "string", "format": "uri" },
    "branch":   { "type": "string" },
    "pr_url":   { "type": "string", "format": "uri" },
    "commit":   { "type": "string", "pattern": "^[0-9a-f]{7,40}$" }
  }
}
```

### 6.4 Обработка ошибок

MCP возвращает ошибки в формате MCP-протокола (`isError: true` + текстовый
content). Категории:

| Код | Когда |
|---|---|
| `INVALID_INPUT` | Параметры не прошли JSON Schema |
| `UNAUTHORIZED` | Нет/неверный `MCP_AUTH_TOKEN` |
| `IDENTITY_REQUIRED` | Нет `X-Agent-Identity` |
| `NOT_FOUND` | Plane вернул 404 |
| `CONFLICT` | Race на claim/transition (см. §6.5) |
| `PLANE_UNAVAILABLE` | Plane API не отвечает / 5xx |
| `RATE_LIMITED` | Сработал внутренний rate limit |
| `INTERNAL` | Прочие сбои; пишется в лог с trace_id |

Каждая ошибка содержит `trace_id`, по которому в логах MCP находится контекст.

### 6.5 Идемпотентность и конкурентность

- `claim_issue` — единственная по-настоящему критичная операция. Реализуется как:
  «прочитать issue → проверить, что нет `agent-claimed` или claim наш →
  записать через Plane API с `If-Match`-семантикой, если Plane её поддерживает,
  иначе с проверкой версии в MCP audit-таблице». При конфликте — `CONFLICT`.
- `link_git_ref` идемпотентен по тройке `(issue_id, repo_url, commit)`.
- `comment_issue` **не** идемпотентен. Клиент сам должен избегать дублей —
  опционально пробрасывая `client_dedup_key`, который MCP проверит в audit.
- Все запросы к Plane API — с retry-budget (3 попытки, exponential backoff,
  jitter, не повторяем 4xx кроме 429).

### 6.6 Rate limiting

MCP ограничивает:

- Глобально: `MCP_RL_GLOBAL_RPS` запросов/сек (по умолчанию 20).
- Per-identity: `MCP_RL_IDENTITY_RPS` (по умолчанию 5).

Превышение — `RATE_LIMITED` с `retry_after_ms`. Лимиты — token bucket в памяти.

### 6.7 Логирование и аудит

- Структурный JSON-лог в stdout. Поля: `ts`, `level`, `trace_id`, `tool`,
  `identity`, `issue_id`, `duration_ms`, `outcome`.
- Опциональный файловый sink — `MCP_LOG_FILE=/var/log/mcp/server.log` (том `mcp_logs`).
- Аудит всех write-операций — отдельная таблица `audit_log` в `mcp_data/audit.sqlite`:
  `trace_id, ts, identity, tool, input_hash, plane_request_id, outcome, error_code`.
- В описание Plane-комментариев MCP **не** добавляет секретных значений (токены,
  пути с пользовательскими credentials).

## 7. Связь с git

MCP сам не клонирует репозитории. Все связи — метаданные:

- Агент создаёт issue → MCP возвращает `sequence_id` (`SLONK-123`).
- Агент создаёт ветку локально по соглашению `feature/SLONK-123-<slug>` (см. [CONVENTIONS.md](./CONVENTIONS.md#git-workflow)).
- Агент вызывает `link_git_ref` при первом push'е.
- Агент вызывает `link_git_ref` повторно при открытии PR (заполняя `pr_url`).
- На merge — `transition_issue(state="Done")` + `link_git_ref` с финальным `commit`.

## 8. Безопасность

- Все секреты — в `.env`, в репозитории — `.env.example` без реальных значений.
- `internal_net` без `external: true`; на хосте порты `postgres`/`redis`/`rabbitmq`/`minio`
  **не** публикуются (исключая dev-режим — отдельный override-файл).
- TLS — задача обратного прокси (Caddy/nginx), MCP сам HTTP-only.
- `MCP_AUTH_TOKEN` ≥ 32 байт энтропии. Bootstrap отказывается стартовать с
  слабым/дефолтным значением.
- `PLANE_API_KEY` имеет workspace-admin scope только в `agents`. Расширение
  scope — осознанное изменение конфига.
- Список IP, с которых разрешён доступ к MCP, — `MCP_ALLOW_CIDR` (по умолчанию
  `127.0.0.1/32, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16`).
- Угрозы и митигации — отдельный раздел в [ARCHITECTURE.md](./ARCHITECTURE.md#модель-угроз).

## 9. Резервное копирование

- Сервис `backup` (опционально, включается профилем `--profile backup`) делает
  `pg_dump` + snapshot MinIO + tar `mcp_data` по cron (`BACKUP_CRON`, по умолчанию
  `0 3 * * *`).
- Бэкап пишется в том `backup_data` и/или выгружается в внешнее S3 при
  `BACKUP_S3_ENDPOINT` + `BACKUP_S3_BUCKET`.
- Restore-процедура — раздел в [CONFIGURATION.md](./CONFIGURATION.md#восстановление-из-бэкапа).

## 10. Acceptance criteria для v1.0

- [ ] `docker compose up -d` поднимает Plane + MCP + инфру без ручных шагов
      сверх описанных в [README.md](./README.md#быстрый-старт).
- [ ] Bootstrap идемпотентен: повторный запуск завершается без ошибок и без
      изменений в Plane.
- [ ] Перезапуск всех контейнеров не приводит к потере данных (issues,
      комментарии, вложения, агент-identities).
- [ ] Claude Code, подключённый к MCP, способен:
  - получить список задач со статусом `To Do`;
  - вызвать `claim_issue`;
  - закоммитить ветку и привязать через `link_git_ref`;
  - перевести задачу в `Code Review` после открытия PR;
  - оставить комментарий с результатом анализа.
- [ ] Параллельный `claim_issue` от двух identity на одну задачу — ровно один
      успешный ответ, второй получает `CONFLICT`.
- [ ] Все write-операции присутствуют в `audit_log`.
- [ ] Сервисы внутри `internal_net` недоступны с хоста (проверено `nmap`).
- [ ] Документация в `docs/` отражает реальное поведение системы.

## 11. Тестирование

- **Unit** — для MCP: схема валидации, парсер meta-блока, rate limiter, retry-логика.
- **Интеграционные** — против реального Plane в Docker (поднимается на CI).
  Сценарии: bootstrap, claim race, transition, link_git_ref round-trip,
  attach_file через MinIO.
- **E2E** — отдельный шаг CI: MCP-клиент проходит сценарий из §10 через MCP-протокол.
- **Smoke** — `make smoke`: 30-секундный health-check всех сервисов после `up`.

Покрытие — минимум 70% строк MCP-сервера, 100% public tools покрыты
интеграционными.

## 12. Метрики и observability (опционально, профиль `--profile obs`)

- MCP экспонирует `/metrics` в Prometheus-формате: `mcp_tool_calls_total`,
  `mcp_tool_duration_seconds`, `mcp_plane_errors_total`, `mcp_rate_limited_total`.
- Plane стандартно метрик не отдаёт; парсим логи через promtail → Loki.
- Grafana — преднастроенный дашборд `slonk-overview` (см. [CONFIGURATION.md](./CONFIGURATION.md#observability)).
