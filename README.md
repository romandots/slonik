# slonk

Self-hosted Kanban task tracker для LLM-агентов на базе [Plane](https://plane.so/) +
собственного MCP-сервера. Один локальный `docker compose up -d` поднимает Plane,
инфраструктуру и MCP, через который Claude Code, Codex и другие MCP-совместимые
агенты работают с задачами.

## Документация

Точка входа для нового пользователя — **[USER_GUIDE](./docs/USER_GUIDE.md)**:
пошаговый сценарий от `git clone` до обученных агентов (установка, настройка
`.env`, bootstrap, подключение Claude Code / Claude Desktop / Codex CLI,
системный промпт для агентов).

Полный набор документации — в [`docs/`](./docs/):

| Документ | О чём |
|---|---|
| [USER_GUIDE](./docs/USER_GUIDE.md) | Пошаговое руководство пользователя |
| [SPEC](./docs/SPEC.md) | Технический контракт: компоненты, MCP API, workflow |
| [ARCHITECTURE](./docs/ARCHITECTURE.md) | Архитектура, сети, контейнеры, потоки данных |
| [CONFIGURATION](./docs/CONFIGURATION.md) | `.env`, compose-overlay'и, bootstrap, версии образов |
| [ROADMAP](./docs/ROADMAP.md) | План реализации с критериями приёмки |
| [CONVENTIONS](./docs/CONVENTIONS.md) | Конвенции кода, инфраструктуры, конфигов, git |
| [CHANGELOG](./docs/CHANGELOG.md) | История изменений |

Для разработки в репо — [`CLAUDE.md`](./CLAUDE.md): структура проекта, команды,
особенности, что строго запрещено.

## Быстрый старт

Все `make`-команды запускаются **из корня репозитория** (там лежит `Makefile`).

```bash
git clone <repo-url> slonk && cd slonk
cp .env.example .env                 # затем заменить все change_me на свои значения
make up                              # поднять весь стек
# открыть http://localhost:3000/god-mode, создать admin'а, получить PLANE_API_KEY,
# записать его в .env, перезапустить mcp-kanban
make bootstrap                       # workspace, project, states, labels, identities
```

Подключить Claude Code одной командой:

```bash
claude mcp add --transport http slonk http://localhost:8787/mcp \
  --header "Authorization: Bearer $MCP_AUTH_TOKEN" \
  --header "X-Agent-Identity: developer-agent"
```

Готовый стартер-кит для запуска агентов под все 6 ролей конвейера (системный
промпт, примеры скиллов под каждую роль, пример MCP-конфига) — в каталоге
[`docs/claude/`](./docs/claude/); как развернуть — [`docs/claude/README.md`](./docs/claude/README.md).

Подробности по всем шагам, Claude Desktop, Codex CLI и системный промпт для
обучения агентов — в [USER_GUIDE](./docs/USER_GUIDE.md).

## Статус

v1.0.0 — все фазы Phase 0–10 закрыты. См.
[ROADMAP](./docs/ROADMAP.md) и [CHANGELOG](./docs/CHANGELOG.md).

## Лицензия

[Apache License 2.0](./LICENSE).
