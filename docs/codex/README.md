# `codex/` — настройки агентов slonk для ChatGPT Codex

Этот каталог описывает, как запустить тот же role-based конвейер slonk в **ChatGPT Codex** по аналогии с `docs/claude/`.

## Что перенести из `docs/claude/`

Для Codex используется та же логика:
- один общий системный промпт с lifecycle;
- ролевые скиллы под стадии конвейера;
- отдельные MCP-коннекты на каждую identity.

Рекомендуемая структура в рабочем окружении Codex:

```text
~/.codex/
├── prompt.md                     # системный промпт (аналог CLAUDE.md)
├── config.toml                   # MCP-конфигурация для Codex CLI/агентов
└── skills/
    ├── slonk-analyst/
    ├── slonk-developer/
    ├── slonk-security-auditor/
    ├── slonk-code-review/
    ├── slonk-qa/
    ├── slonk-doc/
    ├── slonk-merger/
    └── slonk-agent/
```

## 1) Системный промпт

Скопируйте `docs/claude/CLAUDE.md` в `~/.codex/prompt.md` (или в project-level prompt, если используете локальную конфигурацию проекта).

Чтобы не дублировать контент, в этом каталоге есть ссылка-обёртка: [`CODEX.md`](./CODEX.md).

## 2) Скиллы

Скопируйте папку `docs/claude/skills/` в `~/.codex/skills/`.

Каждый ролевой скилл должен запускаться только в сессии с соответствующей `X-Agent-Identity`:
- `analyst-agent` → `slonk-analyst`
- `developer-agent` → `slonk-developer`
- `security-auditor-agent` → `slonk-security-auditor`
- `code-review-agent` → `slonk-code-review`
- `qa-agent` → `slonk-qa`
- `doc-agent` → `slonk-doc`
- `merger-agent` → `slonk-merger`

Оркестратор `slonk-agent` можно использовать в отдельной сессии, где доступны все 7 MCP-подключений.

## 3) MCP для Codex (`~/.codex/config.toml`)

Ниже пример c 7 role-based серверами (по образцу `docs/claude/.mcp.json`):

```toml
[mcp_servers.slonk_analyst]
command = "npx"
args = ["-y", "mcp-remote", "http://localhost:8787/mcp", "--header", "Authorization: Bearer ${MCP_AUTH_TOKEN}", "--header", "X-Agent-Identity: analyst-agent"]

[mcp_servers.slonk_developer]
command = "npx"
args = ["-y", "mcp-remote", "http://localhost:8787/mcp", "--header", "Authorization: Bearer ${MCP_AUTH_TOKEN}", "--header", "X-Agent-Identity: developer-agent"]

[mcp_servers.slonk_security_auditor]
command = "npx"
args = ["-y", "mcp-remote", "http://localhost:8787/mcp", "--header", "Authorization: Bearer ${MCP_AUTH_TOKEN}", "--header", "X-Agent-Identity: security-auditor-agent"]

[mcp_servers.slonk_code_review]
command = "npx"
args = ["-y", "mcp-remote", "http://localhost:8787/mcp", "--header", "Authorization: Bearer ${MCP_AUTH_TOKEN}", "--header", "X-Agent-Identity: code-review-agent"]

[mcp_servers.slonk_qa]
command = "npx"
args = ["-y", "mcp-remote", "http://localhost:8787/mcp", "--header", "Authorization: Bearer ${MCP_AUTH_TOKEN}", "--header", "X-Agent-Identity: qa-agent"]

[mcp_servers.slonk_doc]
command = "npx"
args = ["-y", "mcp-remote", "http://localhost:8787/mcp", "--header", "Authorization: Bearer ${MCP_AUTH_TOKEN}", "--header", "X-Agent-Identity: doc-agent"]

[mcp_servers.slonk_merger]
command = "npx"
args = ["-y", "mcp-remote", "http://localhost:8787/mcp", "--header", "Authorization: Bearer ${MCP_AUTH_TOKEN}", "--header", "X-Agent-Identity: merger-agent"]
```

> Важно: не подставляйте токен литералом в файл. Используйте `${MCP_AUTH_TOKEN}` через окружение.

## 4) Базовый операционный сценарий

1. Создайте issue в `To Do` + label `agent-ready`.
2. Запускайте роль(и) в Codex с соответствующим MCP-сервером.
3. Роль берёт задачу, выполняет шаг своей колонки и двигает карточку через `transition_issue`.
4. `Done` выставляет только `merger-agent` (кроме оговорённых исключений в lifecycle).

## Источники и соответствие

- Канонический lifecycle: `docs/claude/CLAUDE.md`.
- Ролевые инструкции: `docs/claude/skills/*/SKILL.md`.
- Общая идея раскладки и стадий: `docs/claude/README.md`.
