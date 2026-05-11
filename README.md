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

Дополнительно: [`CLAUDE.md`](./CLAUDE.md) в корне — краткие инструкции для
Claude Code (структура, команды, особенности, чего не делать).

## Подключение MCP к агентам

MCP-сервер слушает на `http://localhost:8787/mcp` (порт — `MCP_SERVER_PORT`),
транспорт — MCP-over-HTTP (`StreamableHTTPServerTransport`). Аутентификация —
Bearer-токен из `.env` (`MCP_AUTH_TOKEN`, минимум 32 байта). В каждом запросе
агент обязан передавать заголовок `X-Agent-Identity` с одной из ролей,
созданных bootstrap'ом: `analyst-agent`, `developer-agent`,
`security-auditor-agent`, `code-review-agent`, `qa-agent`, `doc-agent`.

Быстрая проверка, что MCP отвечает:

```bash
# health (без авторизации)
curl -fsS http://localhost:8787/health

# список зарегистрированных tool'ов (Bearer, identity не нужна)
curl -fsS -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  http://localhost:8787/mcp/tools
```

### Claude Code

Claude Code умеет HTTP-транспорт MCP нативно. Два варианта:

**1. Через CLI** (запишет в `~/.claude.json` для пользователя или в
`.mcp.json` проекта при `--scope project`):

```bash
claude mcp add --transport http slonk http://localhost:8787/mcp \
  --header "Authorization: Bearer $MCP_AUTH_TOKEN" \
  --header "X-Agent-Identity: developer-agent"
```

**2. Через файл** `.mcp.json` в корне репозитория (коммитится без секретов —
токен подставит Claude Code из своего окружения):

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

Проверить: в Claude Code запустить `/mcp` — должен появиться сервер `slonk`
со статусом `connected` и списком из 19 tool'ов (`who_am_i`, `list_*`,
`get_issue`, …, `claim_issue`, `attach_file`).

### Claude Desktop

В UI: **Settings → Connectors → Add custom connector** — указать URL
`http://localhost:8787/mcp` и заголовки `Authorization: Bearer <MCP_AUTH_TOKEN>`
+ `X-Agent-Identity: developer-agent`.

Альтернатива через конфиг-файл
(`~/Library/Application Support/Claude/claude_desktop_config.json` на macOS,
`%APPDATA%\Claude\claude_desktop_config.json` на Windows) — поскольку
Claude Desktop по конфигу исторически поддерживает stdio, для HTTP-сервера
используется bridge [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

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
      "env": {
        "MCP_AUTH_TOKEN": "<подставить или экспортировать из shell-окружения>"
      }
    }
  }
}
```

После сохранения — полный перезапуск Claude Desktop (иконка в трее → Quit).

### Codex CLI (OpenAI)

Codex CLI читает `~/.codex/config.toml`. MCP-секция работает через stdio, для
HTTP-сервера используем тот же `mcp-remote` bridge:

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
MCP_AUTH_TOKEN = "<вставить токен или прокинуть из окружения>"
```

Проверить: `codex` → команда `/mcp` (или эквивалент в текущей версии CLI)
покажет `slonk` со списком tool'ов.

### На что обратить внимание

- **Identity на агента**, не на проект. Если один человек запускает Claude Code
  под разными ролями (developer + reviewer) — заведите отдельные MCP-сервера
  с разным `X-Agent-Identity` (`slonk-dev`, `slonk-reviewer`) и разными
  именами серверов.
- **Удалённый доступ** (не `localhost`) — обязательно через `caddy` с TLS
  (Phase 7) и сужение `MCP_ALLOW_CIDR`. По HTTP без TLS токен утечёт.
- **Bootstrap должен быть выполнен** перед первым подключением агента,
  иначе `claim_issue` не найдёт `plane_user_id` для identity.
- **stdio-режим MCP-сервера в slonk пока не реализован** (Phase 2 деливерит
  только HTTP). Для клиентов без HTTP MCP — используйте `mcp-remote` как
  показано выше.

Полный референс конфигурации, в т.ч. для прод-развёртывания через `caddy`, —
[CONFIGURATION.md §6](./plane/docs/CONFIGURATION.md#6-подключение-агентов).

## Статус

Проект в стадии разработки. Текущая фаза — см. [ROADMAP](./plane/docs/ROADMAP.md)
и [CHANGELOG](./plane/docs/CHANGELOG.md).
