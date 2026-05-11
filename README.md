# slonk

Self-hosted Kanban task tracker для LLM-агентов на базе [Plane](https://plane.so/) +
собственного MCP-сервера. Один локальный `docker compose up -d` поднимает Plane,
инфраструктуру и MCP, через который Claude Code, Codex и другие MCP-совместимые
агенты работают с задачами.

## Документация

Вся проектная документация — в [`plane/docs/`](./plane/docs/):

| Документ | О чём |
|---|---|
| [README](./plane/docs/README.md) | Обзор, быстрый старт, подключение агентов |
| [SPEC](./plane/docs/SPEC.md) | Технический контракт: компоненты, MCP API, workflow |
| [ARCHITECTURE](./plane/docs/ARCHITECTURE.md) | Архитектура, сети, контейнеры, потоки данных |
| [CONFIGURATION](./plane/docs/CONFIGURATION.md) | `.env`, compose, bootstrap, подключение агентов |
| [ROADMAP](./plane/docs/ROADMAP.md) | Поэтапный план реализации с критериями приёмки |
| [CONVENTIONS](./plane/docs/CONVENTIONS.md) | Конвенции кода, инфраструктуры, конфигов, git |
| [CHANGELOG](./plane/docs/CHANGELOG.md) | История изменений |

## Статус

Проект в стадии разработки. Текущая фаза — см. [ROADMAP](./plane/docs/ROADMAP.md)
и [CHANGELOG](./plane/docs/CHANGELOG.md).
