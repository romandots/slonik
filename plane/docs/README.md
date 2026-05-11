# slonk — self-hosted Kanban для код-агентов

Локально разворачиваемое решение для task-tracking workflow LLM-агентов
(Claude Code, Codex и любых MCP-совместимых клиентов) на базе [Plane](https://plane.so/)
и собственного MCP-сервера.

## Что это

Стек, в котором:

- **Plane** выступает как канбан-доска и task tracker (workspaces, projects, issues,
  states, labels, cycles, modules, comments, attachments, webhooks, REST API).
- **MCP Server** — прослойка между LLM-агентами и Plane API. Отдаёт агентам
  нормализованный, безопасный и ограниченный набор инструментов.
- **PostgreSQL / Redis / RabbitMQ / MinIO** — инфраструктурные сервисы для Plane.
- Опциональный observability/backup-стек поверх (Prometheus / Grafana / Loki / cron-бэкапы).

LLM-агент читает backlog, берёт задачу в работу, меняет статус, оставляет комментарии,
прикрепляет результаты анализа и связывает задачу с веткой / коммитом / PR — всё через MCP.

```text
Claude Code / Codex  →  MCP Client  →  Kanban MCP Server  →  Plane REST API
                                                              ↓
                                            Plane + PostgreSQL + RabbitMQ + Redis + MinIO
```

## Что НЕ входит

- SaaS- / multi-tenant-хостинг. Только self-hosted single-tenant.
- Форк Plane. Используем upstream-образы как есть.
- Универсальный коннектор к Jira / Linear / GitHub Issues. Это потенциальное
  расширение, но не цель v1.

## Документация

| Документ | О чём |
|---|---|
| [SPEC.md](./SPEC.md) | Техническая спецификация: компоненты, MCP API, контракт workflow |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Архитектура, сети, контейнеры, потоки данных |
| [CONFIGURATION.md](./CONFIGURATION.md) | Полный референс `.env`, compose, bootstrap, подключение агентов |
| [ROADMAP.md](./ROADMAP.md) | Поэтапный план реализации с критериями приёмки |
| [CONVENTIONS.md](./CONVENTIONS.md) | Конвенции кода, инфраструктуры, конфигов, git |
| [CHANGELOG.md](./CHANGELOG.md) | История изменений в формате Keep a Changelog |

## Быстрый старт

### Требования

- Docker ≥ 24 и Docker Compose v2.
- 4 CPU, 8 GB RAM, 20 GB свободного диска для dev-окружения.
- Свободные порты на хосте: `3000` (Plane UI), `8000` (Plane API), `8787` (MCP),
  `9000`/`9001` (MinIO console).

### Установка

```bash
git clone <repo-url> slonk
cd slonk

# 1. Конфиг
cp .env.example .env
# Открыть .env и заменить ВСЕ *_PASSWORD, *_SECRET, *_TOKEN на свои значения.
# Минимум: POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD, MCP_AUTH_TOKEN, PLANE_SECRET_KEY.

# 2. Поднимаем стек
docker compose up -d

# 3. Ждём готовности Plane (health-чек plane-api). Первый запуск инициализирует БД.
docker compose logs -f plane-api

# 4. Создаём admin-пользователя Plane
docker compose exec plane-api ./bin/bootstrap-admin.sh \
  --email admin@example.com --password <strong-password>

# 5. Bootstrap MCP: workspace, project, states, labels, agent-identities
docker compose run --rm mcp-kanban bootstrap

# 6. Получаем API-ключ Plane для MCP
#    Открыть http://localhost:3000 → Settings → API Tokens → Create.
#    Положить в .env: PLANE_API_KEY=...

# 7. Перезапускаем MCP с новым ключом
docker compose up -d mcp-kanban
```

### Подключение агента

Claude Code (`~/.claude/mcp.json` или `.mcp.json` в корне проекта):

```jsonc
{
  "mcpServers": {
    "slonk-kanban": {
      "url": "http://localhost:8787/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

Codex CLI и stdio-режим — см. [CONFIGURATION.md](./CONFIGURATION.md#подключение-агентов).

### Проверка работоспособности

```bash
# Plane API
curl -fsS http://localhost:8000/api/v1/health

# MCP health
curl -fsS -H "Authorization: Bearer $MCP_AUTH_TOKEN" http://localhost:8787/health

# Список доступных MCP-инструментов
curl -fsS -H "Authorization: Bearer $MCP_AUTH_TOKEN" http://localhost:8787/mcp/tools
```

## Безопасность по умолчанию

- Все секреты — только через `.env`, в репозиторий не коммитятся.
- Доступ к Plane API из MCP — по `PLANE_API_KEY` admin-уровня workspace `agents`.
- Доступ агентов к MCP — по `MCP_AUTH_TOKEN` (Bearer).
- `postgres`, `redis`, `rabbitmq`, `minio` живут на `internal_net` и наружу не публикуются.
- Прод-развёртывание подразумевает обратный прокси (Caddy / nginx) с TLS — см.
  [CONFIGURATION.md](./CONFIGURATION.md#обратный-прокси-и-tls).

## Поддержка

Issues — на канбан-доске самого slonk в проекте `meta`. Внешним контрибьюторам — см.
[CONVENTIONS.md](./CONVENTIONS.md).

## Лицензия

Определяется на этапе релиза 1.0 (см. [ROADMAP.md](./ROADMAP.md)).
