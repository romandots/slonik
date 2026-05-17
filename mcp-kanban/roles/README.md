# `roles/` — определение agent-identities

Каждый `*.md`-файл здесь описывает одну роль агента в slonk. Bootstrap
(`make bootstrap`) читает все `*.md` из этой директории, валидирует их
схемой и наполняет SQLite-стор identity (`mcp_data/identity.sqlite`).
Реестр идентичностей, против которого MCP-сервер валидирует заголовок
`X-Agent-Identity` в запросах от LLM-агентов, собирается из того же стора.

## Где живёт директория

В Docker-образе `mcp-kanban` директория лежит по пути `/app/roles`. В
`docker-compose.yml` она пробрасывается bind-mount'ом из репозитория
(`./mcp-kanban/roles:/app/roles:ro`) — правки `*.md`-файлов
подхватываются после `docker compose up -d mcp-kanban` + `make bootstrap`,
**без `make build`**.

Путь можно переопределить переменной окружения `MCP_ROLES_DIR`.

## Формат файла

```markdown
---
role: developer-agent                       # обязательное, snake-case-with-dash
email: developer-agent@slonk.local          # обязательное, валидный email
first_name: Developer                       # обязательное
last_name: Agent                            # обязательное
default_state: Development                  # обязательное, имя колонки в Plane
state_aliases:                              # опциональное
  - Разработка
  - Coding
---
# developer-agent

Человекочитаемое описание роли — для оператора, не для агента.
Тело markdown-файла bootstrap не парсит.
```

- `default_state` — каноническое имя колонки в Plane-канбане, в которую
  по умолчанию переводит задачу `claim_issue` для этой роли.
- `state_aliases` — список синонимов на других языках или для
  переименованных колонок. `claim_issue` принимает как имя из
  `default_state`, так и любой алиас (case-insensitive).
- Тело markdown (после второго `---`) — человекочитаемое описание.
  Bootstrap его не использует, но коммитим вместе с метаданными, чтобы
  оператору / новому агенту было ясно, что роль делает.

## Что коммитится в git, а что нет

Дефолтные 7 ролей (`analyst-agent.md`, `developer-agent.md`,
`security-auditor-agent.md`, `code-review-agent.md`, `qa-agent.md`,
`doc-agent.md`, `merger-agent.md`) **в репозитории** — это коробочный
набор slonk, на который завязаны примеры скиллов в `docs/claude/`.

Все остальные `*.md`-файлы в этой директории **игнорируются git'ом**
(см. `.gitignore`). Добавление кастомной роли (например, `release-agent`,
`triage-agent`, `i18n-agent`) — это просто `cp developer-agent.md
release-agent.md` + правка front-matter; после `make bootstrap` агент с
заголовком `X-Agent-Identity: release-agent` начинает приниматься
MCP-сервером, а `claim_issue` будет переводить задачи в колонку из
`default_state`.

## Маппинг роли на колонку Plane

`claim_issue` резолвит `default_state` в `state_id` следующим образом:

1. точное совпадение `state.name == default_state` (case-sensitive);
2. case-insensitive совпадение;
3. case-insensitive совпадение с любым из `state_aliases`;
4. иначе — `INVALID_INPUT` с пояснением «no such state in project X;
   add it to state_aliases or rename in Plane».

Это позволяет одной и той же роли работать с проектами, где колонки
названы по-разному (например, английский vs русский), без перебилда
образа.

## Fallback на manifest

Если директория `roles/` пуста (или отсутствует), bootstrap читает
секцию `identities:` из `bootstrap/manifest.yaml` — это нужно для
обратной совместимости с инсталляциями, обновляющимися с версии без
поддержки `roles/`. Свежие инсталляции **должны** держать роли в этой
директории — `manifest.yaml.identities` объявлен legacy.
