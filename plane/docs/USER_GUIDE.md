# Руководство пользователя — slonk

Документ-сценарий «с нуля до работающих агентов». От `git clone` до момента,
когда Claude Code / Claude Desktop / Codex CLI берут задачи из канбана и
двигают их по workflow.

Этот файл — не альтернатива [SPEC.md](./SPEC.md) и
[CONFIGURATION.md](./CONFIGURATION.md), а навигационный гид. Каждый шаг ссылается
на соответствующий раздел референса.

## 0. Что у вас получится в итоге

После прохождения всех шагов локально будет работать:

- Plane UI на `http://localhost:3000` (workspace `agents`, проект «Code Agents
  — Default Project», identifier `SLONK`, с 11 канбан-состояниями и 14 лейблами);
- MCP-сервер на `http://localhost:8787/mcp` с 22 tool'ами (3 git-tool'а +
  10 read + 8 write + `who_am_i`);
- 6 идентичностей агентов в Plane: `analyst-agent`, `developer-agent`,
  `security-auditor-agent`, `code-review-agent`, `qa-agent`, `doc-agent`;
- Claude Code (и/или Claude Desktop / Codex CLI) подключённый к MCP и
  обученный жить по workflow: `claim_issue` → работа → `transition_issue` →
  `link_git_ref` → `comment_issue` → `release_issue` / `Done`.

## 1. Подготовка хоста

### 1.1 Требования

| Что | Минимум |
|---|---|
| ОС | macOS 13+, Linux (любой современный дистрибутив), Windows 11 + WSL2 |
| Docker | Engine ≥ 24, Compose v2 |
| CPU / RAM / диск | 4 CPU, 8 GB RAM, 20 GB свободного диска |
| Свободные порты на хосте | `3000` (Plane UI), `8787` (MCP). С `dev`-overlay'ем — также `8000`, `5432`, `6379`, `5672`, `15672`, `9000`, `9001`. |
| Node.js (опционально) | 22 LTS — нужен только если хочется гонять `mcp-kanban` локально без Docker. Для штатного использования не требуется. |

### 1.2 Клонирование

```bash
git clone <repo-url> slonk
cd slonk
cp .env.example .env
```

## 2. Настройка `.env`

Открыть `.env` и заменить **все** значения `change_me` и пустые секреты.
Полный референс всех переменных — в
[CONFIGURATION.md §2](./CONFIGURATION.md#2-env-reference).

### 2.1 Минимальный обязательный набор (локальная разработка)

```bash
# Plane — Django SECRET_KEY и HMAC для realtime. Сгенерировать так:
openssl rand -hex 32   # → положить в PLANE_SECRET_KEY
openssl rand -hex 32   # → положить в PLANE_LIVE_SECRET_KEY

# Bearer-токен MCP. ≥ 32 байта энтропии, иначе bootstrap не стартует.
openssl rand -hex 32   # → MCP_AUTH_TOKEN
```

| Переменная | Что сделать |
|---|---|
| `PLANE_SECRET_KEY` | заполнить (32+ hex-байт) |
| `PLANE_LIVE_SECRET_KEY` | заполнить (32+ hex-байт) |
| `POSTGRES_PASSWORD` | любой пароль длиной ≥ 16 символов |
| `RABBITMQ_DEFAULT_PASS` | любой пароль |
| `MINIO_ROOT_PASSWORD` | любой пароль ≥ 8 символов (требование MinIO) |
| `MCP_AUTH_TOKEN` | заполнить (32+ hex-байт) |
| `PLANE_API_KEY` | **оставить пустым** — получим в шаге 4 |

### 2.2 Что менять для прод-развёртывания

- `PLANE_DOMAIN` / `PLANE_APP_BASE_URL` / `PLANE_ADMIN_BASE_URL` / `PLANE_SPACE_BASE_URL` /
  `PLANE_LIVE_BASE_URL` — на реальный публичный URL (`https://plane.example.com`).
- `PLANE_CORS_ALLOWED_ORIGINS` — этот же URL.
- `MCP_ALLOW_CIDR` — сузить с дефолтного `0.0.0.0/0` до сети, откуда ходят агенты.
- Включить `proxy`-overlay (см. §3.4), задать `CADDY_DOMAIN`, `CADDY_MCP_DOMAIN`,
  `CADDY_ACME_EMAIL`.

Все ENV-переменные валидируются `zod`-схемой в `mcp-kanban/src/config.ts` на
старте — при опечатке MCP не запустится и в лог пойдёт человеко-читаемая ошибка.

## 3. Запуск стека

> Все `make`-команды ниже запускаются **из корня репозитория** (`slonk/`,
> там лежит `Makefile` и `docker-compose.yml`). Из любого подкаталога — в т.ч.
> `plane/docs/` — `make up` выдаст `No rule to make target 'up'`.

### 3.1 Базовый старт

```bash
make up
```

Что произойдёт:

- Docker Compose поднимет 13 контейнеров: `plane-web`, `plane-admin`,
  `plane-space`, `plane-live`, `plane-api`, `plane-worker`, `plane-beat`,
  `plane-migrator`, `plane-proxy`, `postgres`, `redis (valkey)`, `rabbitmq`,
  `minio`, `mcp-kanban`.
- `plane-migrator` единоразово накатит миграции Django и завершится — это
  ожидаемое поведение.
- `--wait` ждёт, пока все healthchecks не вернут healthy.

Проверка:

```bash
make ps      # все контейнеры в состоянии Up (healthy)
make smoke   # curl Plane UI на http://localhost:3000
```

### 3.2 Overlay для разработки (dev)

```bash
make up-dev
```

Поверх базового стека публикует на хост порты Postgres / Redis / RabbitMQ /
MinIO / `plane-api`. Удобно для отладки запросов к Plane API напрямую, для
прода — **не использовать**.

### 3.3 Overlay для наблюдаемости (obs)

```bash
make up-obs
```

Добавляет Prometheus, Grafana, Loki, Promtail. Дашборд `slonk-overview`
провижится автоматически. Доступ:

- Grafana: `http://localhost:3001` (логин из `GRAFANA_ADMIN_USER` /
  `GRAFANA_ADMIN_PASSWORD`).
- Prometheus: `http://localhost:9090`.

Чтобы Prometheus реально снимал метрики MCP — установить `MCP_METRICS_ENABLED=true`
в `.env` и перезапустить `mcp-kanban`.

### 3.4 Overlay для внешнего TLS (proxy)

```bash
make up-proxy
```

Поверх стека встаёт отдельный Caddy 2.8 на `:80/:443`, базовые порты
(`3000`, `8787`) больше не публикуются. Этот режим — для прод-развёртывания
с реальным FQDN. Перед запуском в `.env`:

```env
CADDY_DOMAIN=plane.example.com
CADDY_MCP_DOMAIN=mcp.example.com
CADDY_ACME_EMAIL=ops@example.com
```

Caddy сам выпустит сертификаты Let's Encrypt при первом запросе. Для on-prem
без публичного DNS — использовать `tls internal` (см. комментарии в
`caddy/Caddyfile`).

### 3.5 Overlay для бэкапов (backup)

```bash
make up-backup        # cron-bound бэкап, по умолчанию ежедневно в 03:00 UTC
make backup-now       # разовый прогон
```

Бэкап делает `pg_dump`, `mc mirror` MinIO-бакетов и `tar` тома `mcp_data` —
складывает всё в `backup_data` volume. Восстановление —
[CONFIGURATION.md §9](./CONFIGURATION.md#восстановление-из-бэкапа).

### 3.6 Остановка

```bash
make down            # сохраняет volume'ы (данные не теряются)
make down-v          # ВНИМАНИЕ: удаляет volume'ы, нужно явное "yes"
```

## 4. Первый bootstrap

### 4.1 Создать admin'а Plane

1. Открыть `http://localhost:3000/god-mode` — Plane предложит создать первого
   администратора инстанса.
2. Зайти под этим админом в основной UI на `http://localhost:3000`.

### 4.2 Получить API-ключ Plane

В Plane UI: **Workspace settings → API tokens → Create token** (http://localhost:3000/agents/settings/api-tokens). Скопировать
значение и положить в `.env`:

```env
PLANE_API_KEY=plane_api_xxxxxxxxxxxxxxxxxxxxx
```

Перезапустить только MCP, чтобы он подхватил ключ:

```bash
docker compose up -d mcp-kanban
```

### 4.3 Запустить bootstrap

```bash
make bootstrap
```

Что сделает скрипт (идемпотентно — повторный запуск даёт `created: 0` по всем
коллекциям):

1. Создаст workspace `agents` (slug — `MCP_DEFAULT_WORKSPACE`).
2. Создаст проект «Code Agents — Default Project» с identifier `SLONK`
   (на него и указывают `MCP_DEFAULT_PROJECT` / `MCP_ALLOWED_PROJECTS`) и
   модулями cycles / modules / views / pages.
3. Создаст 11 состояний канбана: `Backlog → To Do → Analysis → Development →
   Security Review → Code Review → Testing → Documenting → Blocked → Done →
   Cancelled`.
4. Создаст 14 лейблов: `agent-ready`, `agent-claimed`, `agent-blocked`,
   `needs-human`, `needs-review`, `needs-tests`, `bug`, `feature`,
   `refactoring`, `docs`, `infra`, `security`, `high-priority`, `low-priority`.
5. Заведёт 6 agent-identities. По умолчанию `MCP_AGENT_IDENTITY_MODE=per_user`
   — bootstrap инвайтит 6 пользователей; при ошибке инвайта автоматически
   падает на `single_bot`, маппинг `role → plane_user_id` пишется в
   `mcp_data/identity.sqlite`.

Успешный финал — строка `BOOTSTRAP OK` в выводе.

Содержимое манифеста и логика bootstrap'а —
[SPEC.md §5](./SPEC.md#5-plane-данные-и-bootstrap) и
[CONFIGURATION.md §4](./CONFIGURATION.md#4-bootstrap-plane).

### 4.4 Проверка работоспособности MCP

```bash
# Plane health
curl -fsS http://localhost:3000/

# MCP health — без авторизации
curl -fsS http://localhost:8787/health

# Список tool'ов — Bearer обязателен, identity не нужна
curl -fsS -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  http://localhost:8787/mcp/tools
```

В ответе `/mcp/tools` должно быть 22 имени: `who_am_i`, `list_workspaces`,
`list_projects`, `list_states`, `list_labels`, `list_cycles`, `list_modules`,
`list_issues`, `get_issue`, `search_issues`, `get_issue_history`,
`create_issue`, `update_issue`, `transition_issue`, `claim_issue`,
`release_issue`, `block_issue`, `comment_issue`, `attach_file`,
`link_git_ref`, `unlink_git_ref`, `find_issues_by_git_ref`.

## 5. Подключение агентов

Общий контракт:

- Endpoint: `http://localhost:8787/mcp` (dev) или `https://mcp.example.com/mcp`
  (с proxy-overlay).
- `Authorization: Bearer <MCP_AUTH_TOKEN>` — обязательный заголовок.
- `X-Agent-Identity: <role>` — одна из 6 ролей bootstrap'а. Без него MCP
  отдаст `401 IDENTITY_REQUIRED`.
- Транспорт — MCP-over-HTTP (`StreamableHTTPServerTransport`, MCP SDK ≥ 1.29).
- stdio-режим в slonk **пока не реализован** — для клиентов без HTTP MCP
  используется bridge [`mcp-remote`](https://www.npmjs.com/package/mcp-remote).

> Identity — на агента, не на пользователя. Если человек запускает Claude Code
> одновременно как `developer-agent` и как `code-review-agent`, заводите два
> MCP-сервера в конфиге клиента с разными именами (`slonk-dev`,
> `slonk-reviewer`) и разным `X-Agent-Identity`.

### 5.1 Claude Code (CLI)

Самый быстрый путь:

```bash
claude mcp add --transport http slonk http://localhost:8787/mcp \
  --header "Authorization: Bearer $MCP_AUTH_TOKEN" \
  --header "X-Agent-Identity: developer-agent"
```

Без `--scope` — запись в `~/.claude.json` (пользовательский конфиг).
С `--scope project` — в `.mcp.json` в корне репо, который можно коммитить
(токен подставится из окружения):

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

Проверка: внутри `claude` выполнить `/mcp` — сервер `slonk` должен быть в
статусе `connected` со списком 22 tool'ов.

### 5.2 Claude Desktop

**Через UI (рекомендуется):** Settings → Connectors → Add custom connector,
URL `http://localhost:8787/mcp`, заголовки `Authorization` и
`X-Agent-Identity`. После сохранения — полный перезапуск Claude Desktop
(Quit, не закрытие окна).

**Через файл конфигурации** (для версий без UI коннекторов или для
скриптовой настройки):

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

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
      "env": { "MCP_AUTH_TOKEN": "<токен или экспорт из shell>" }
    }
  }
}
```

### 5.3 Codex CLI (OpenAI)

Codex CLI читает `~/.codex/config.toml`. MCP-серверы у него работают через
stdio, поэтому HTTP slonk оборачиваем тем же `mcp-remote`:

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
MCP_AUTH_TOKEN = "<токен или прокинуть из окружения>"
```

Проверка — `codex` → `/mcp`, должен показать сервер `slonk` со списком tool'ов.

### 5.4 Кастомные MCP-клиенты

Любой клиент, говорящий MCP-over-HTTP (StreamableHTTP, MCP SDK ≥ 1.29):

- POST `/mcp` с JSON-RPC, GET `/mcp` апгрейдится в SSE-стрим;
- сессия идентифицируется заголовком `mcp-session-id`, который MCP возвращает
  на `initialize` и ожидает в последующих запросах;
- диагностика — `GET /mcp/tools` (Bearer обязателен, identity нет).

Полный референс — [SPEC.md §6.1](./SPEC.md#61-транспорт-и-аутентификация).

## 6. Обучение агентов

Технически «обучение» сводится к двум вещам:

1. В системный промпт агента положить **системную инструкцию по slonk**
   (правила, контракт workflow, перечень состояний, формат meta-блока).
2. Запускать каждого агента под нужной identity и в нужном рабочем каталоге.

### 6.1 Системная инструкция (готовый промпт)

Скопируйте этот текст в системный промпт агента — в Claude Code это
`CLAUDE.md` репозитория-задачи или `~/.claude/CLAUDE.md` для глобальных правил,
в Claude Desktop — поле Custom Instructions, в Codex CLI — `~/.codex/prompt.md`
или аналог.

```markdown
# slonk — рабочие правила агента

Тебе доступен MCP-сервер `slonk` (канбан на базе Plane). ЛЮБАЯ работа над
задачей идёт через него: ты НЕ открываешь Plane UI, не зовёшь Plane API
напрямую и не двигаешь задачи руками.

## Идентичность

Ты выступаешь как одна из 6 ролей: `analyst-agent`, `developer-agent`,
`security-auditor-agent`, `code-review-agent`, `qa-agent`, `doc-agent`.
Identity заранее зашита в заголовок `X-Agent-Identity` твоего MCP-клиента,
проверь её через tool `who_am_i` в начале каждой сессии.

## Канбан-workflow

Состояния и переходы:

  Backlog → To Do → Analysis → Development → Security Review → Code Review →
  Testing → Documenting → Done

Параллельные ветки:
- `Blocked` — задача ждёт фидбек человека или соседнего агента.
- `Cancelled` — задача отменена.

Каждая роль работает в «своём» состоянии (см. `default_state` в bootstrap):

| Identity                  | State            |
|---------------------------|------------------|
| analyst-agent             | Analysis         |
| developer-agent           | Development      |
| security-auditor-agent    | Security Review  |
| code-review-agent         | Code Review      |
| qa-agent                  | Testing          |
| doc-agent                 | Documenting      |

## Жизненный цикл задачи (твой обязательный сценарий)

1. **Найти работу.** `list_issues({ state: "To Do", labels: ["agent-ready"] })`
   или `search_issues` по ключевому слову. Не бери задачу с лейблом
   `needs-human` без явного указания человека.
2. **Взять в работу.** `claim_issue({ issue_id })`. Если возврат `CONFLICT` —
   задачу уже забрал другой агент, ищи следующую.
3. **Понять контекст.** `get_issue({ issue_id })` — прочитай title,
   description, meta-блок (`<!-- slonk:meta v1 -->`), последние комментарии,
   `get_issue_history` если надо.
4. **Связать с кодом.** Создай ветку по конвенции
   `feature/SLONK-<seq>-<slug>` и вызови
   `link_git_ref({ issue_id, repo_url, branch })` сразу при первом push'е.
5. **Сделай работу.** Пиши код, тесты, документацию — в зависимости от роли.
   Каждый значимый шаг — `comment_issue({ issue_id, body })` коротким
   человеческим языком.
6. **Передай дальше.** Открыл PR — вызови
   `link_git_ref({ issue_id, repo_url, pr_url })` и
   `transition_issue({ issue_id, state: "Code Review" })`. Если задача
   заблокирована — `block_issue({ issue_id, reason })`.
7. **Никогда не закрывай чужую работу.** `transition → Done` делает только
   та роль, которая ведёт финальное состояние (по умолчанию `doc-agent`
   после `Documenting`).

## Контракт ошибок

- `CONFLICT` на `claim_issue` / `transition_issue` — гонка, ищи другую задачу.
- `INVALID_INPUT` — ты передал плохие параметры, не повторяй вызов без правки.
- `RATE_LIMITED` — подожди `retry_after_ms` мс.
- `PLANE_UNAVAILABLE` — Plane упал, оповести человека комментом
  `block_issue`-ом и пометь `needs-human`.

## Что СТРОГО запрещено

- Прямые запросы к Plane API в обход MCP.
- Закрытие/удаление задач без перевода в `Done` или `Cancelled`.
- Изменение meta-блока в description руками (только через `link_git_ref` /
  `unlink_git_ref`).
- Игнорирование лейбла `needs-human` — это знак, что задаче нужен живой
  ревьюер.
- Логирование `MCP_AUTH_TOKEN`, `PLANE_API_KEY`, presigned URL'ов.
```

Полный контракт workflow и форматы ошибок — [SPEC.md §6](./SPEC.md#6-mcp-server-api).

### 6.2 Привязка идентичностей к запускам

Стандартная схема — один Claude Code per role, или несколько MCP-сервер
записей в конфиге клиента с разным `X-Agent-Identity`. Например в
`~/.claude.json`:

```jsonc
{
  "mcpServers": {
    "slonk-dev":      { "type": "http", "url": "http://localhost:8787/mcp",
                        "headers": { "Authorization": "Bearer ${MCP_AUTH_TOKEN}",
                                     "X-Agent-Identity": "developer-agent" } },
    "slonk-reviewer": { "type": "http", "url": "http://localhost:8787/mcp",
                        "headers": { "Authorization": "Bearer ${MCP_AUTH_TOKEN}",
                                     "X-Agent-Identity": "code-review-agent" } },
    "slonk-qa":       { "type": "http", "url": "http://localhost:8787/mcp",
                        "headers": { "Authorization": "Bearer ${MCP_AUTH_TOKEN}",
                                     "X-Agent-Identity": "qa-agent" } }
  }
}
```

Внутри `claude` командой `/mcp use slonk-reviewer` можно переключиться между
ролями в одной сессии (актуально для отладки workflow).

### 6.3 Создание первой задачи для агента

Через Plane UI:

1. Открыть проект «Code Agents» (identifier `SLONK`).
2. Создать issue с состоянием `To Do` и лейблом `agent-ready` (обязательно
   — это маркер «бери в работу»).
3. В description описать задачу по-человечески; meta-блок (`<!-- slonk:meta
   v1 -->`) добавится автоматически при первом `link_git_ref`.
4. Опционально — повесить дополнительный лейбл (`bug`, `feature`, `docs`,
   `infra`, `security`, `high-priority`) для приоритезации.

Через агента из CLI:

```text
> Создай в slonk-канбане задачу с title "Починить флапающий тест X"
  и лейблами agent-ready, bug.
```

Агент вызовет `create_issue` — задача появится в `Backlog` workspace `agents`,
проекта `SLONK` (переведите её в `To Do`, чтобы агенты взяли её в работу).

### 6.4 Что увидите в логах после первого цикла

Все write-операции пишутся в `mcp_data/audit.sqlite` (таблица `audit_log`).
Каждая запись содержит `trace_id`, `identity`, `tool`, `outcome`. Это
основной канал отладки «кто что сделал и когда».

Структурный JSON-лог самого процесса MCP — в stdout (или в файл при
`MCP_LOG_FILE`). Поля: `ts`, `level`, `trace_id`, `tool`, `identity`,
`issue_id`, `duration_ms`. Секреты редактируются автоматически —
[CONVENTIONS.md §3 / pino-redact](./CONVENTIONS.md).

## 7. Чек-лист первого запуска

- [ ] `.env` создан, все `change_me` заменены, `PLANE_API_KEY` пока пустой.
- [ ] `make up` поднял все 13 контейнеров; `make ps` — все healthy.
- [ ] Plane UI открывается на `http://localhost:3000`, создан god-mode admin.
- [ ] `PLANE_API_KEY` получен в UI, записан в `.env`, `mcp-kanban`
      перезапущен (`docker compose up -d mcp-kanban`).
- [ ] `make bootstrap` завершился `BOOTSTRAP OK`.
- [ ] `curl /health` MCP возвращает `{"status":"ok"}` с `plane_reachable: true`.
- [ ] `curl /mcp/tools` возвращает 22 имени.
- [ ] Claude Code (или другой клиент) видит сервер `slonk` со списком tool'ов
      (`/mcp` внутри CLI).
- [ ] Тестовый `who_am_i` возвращает правильную identity.
- [ ] Тестовый `claim_issue` на специально созданной issue работает; второй
      параллельный вызов возвращает `CONFLICT`.

## 8. Что дальше

- Прод-развёртывание с TLS — [CONFIGURATION.md §7](./CONFIGURATION.md#7-обратный-прокси-и-tls)
  + `make up-proxy`.
- Регулярные бэкапы — [CONFIGURATION.md §9](./CONFIGURATION.md#9-backup)
  + `make up-backup`.
- Мониторинг и алерты — [CONFIGURATION.md §8](./CONFIGURATION.md#8-observability)
  + `make up-obs`. Дашборд `slonk-overview` в Grafana покажет
  `mcp_tool_calls_total`, `mcp_tool_duration_seconds`,
  `mcp_plane_errors_total`, `mcp_rate_limited_total`.
- Security baseline (угрозы, митигации, что отвечать на инциденты) —
  [`SECURITY.md`](../../SECURITY.md) в корне репо и
  [ARCHITECTURE.md §Модель угроз](./ARCHITECTURE.md#модель-угроз).
- Поэтапная история и план — [ROADMAP.md](./ROADMAP.md) и
  [CHANGELOG.md](./CHANGELOG.md).

## 9. Troubleshooting

| Симптом | Что проверить |
|---|---|
| `make: *** No rule to make target 'up'` | Запущено не из корня репо. `cd` в корень `slonk/` (где `Makefile`) и повторить. |
| `make up` зависает на `--wait` | `make logs` — обычно `plane-migrator` крутит миграции, ждать до 2 минут. Если падает — Postgres не поднялся, проверить `POSTGRES_PASSWORD`. |
| Plane UI отдаёт 502 | `plane-proxy` не нашёл upstream-сервис. Проверить `docker compose ps` — все ли `plane-*` healthy; перезапустить `docker compose restart plane-proxy`. |
| `bootstrap` падает на `PLANE_API_KEY invalid` | Ключ не админский или сделан в другом workspace. Создайте новый workspace-admin token в UI и пропишите в `.env`. |
| `bootstrap` падает на `INSECURE_MCP_AUTH_TOKEN` | Токен короче 32 байт или похож на `change_me`. Сгенерировать `openssl rand -hex 32`. |
| Claude Code говорит `connection refused` | Проверить `curl http://localhost:8787/health` с хоста. Если работает — клиент смотрит не в тот URL. Если нет — `mcp-kanban` не поднялся, `docker compose logs mcp-kanban`. |
| Все вызовы возвращают `401 IDENTITY_REQUIRED` | Не передан заголовок `X-Agent-Identity`. Добавить в конфиг клиента. |
| `claim_issue` всегда `CONFLICT` | Задача уже claim'нута другой identity. `release_issue` от имени той роли или `get_issue` посмотреть текущего assignee. |
| Агент игнорирует workflow | Проверить, что системный промпт §6.1 действительно загружен в контекст (в Claude Code — `CLAUDE.md` в корне проекта или `~/.claude/CLAUDE.md`). |

Если ничего из этого не помогает — собрать логи всех контейнеров
(`docker compose logs --since 10m > /tmp/slonk.log`) и завести issue в самом
slonk-канбане (workspace `agents`, проект `SLONK`, лейбл
`needs-human`).
