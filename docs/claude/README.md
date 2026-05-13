# `claude/` — стартер-кит для агентов slonk

Готовый набор для запуска LLM-агентов поверх slonk-канбана: системный промпт +
ролевые скиллы под 7 ролей конвейера + скилл-оркестратор + пример MCP-конфига.
Скопируйте нужные части к себе — либо по агенту на роль, либо один оркестратор
на всё.

```
claude/
├── README.md            # этот файл
├── CLAUDE.md            # системный промпт slonk + канонический рабочий цикл (= docs/USER_GUIDE.md §6.1)
├── .mcp.json            # пример: 7 role-based MCP-серверов slonk одним файлом
└── skills/
    ├── slonk-analyst/SKILL.md
    ├── slonk-developer/SKILL.md
    ├── slonk-security-auditor/SKILL.md
    ├── slonk-code-review/SKILL.md
    ├── slonk-qa/SKILL.md
    ├── slonk-doc/SKILL.md
    ├── slonk-merger/SKILL.md          # узкая роль: мерж ветки + конфликты, закрытие в Done
    └── slonk-agent/SKILL.md           # оркестратор: ведёт задачу/доску через весь конвейер
```

## Идея

slonk — конвейер: `Backlog → To Do → Analysis → Development → Security Review →
Code Review → Testing → Documenting → Merging → Done` (+ `Blocked`, `Cancelled`).
Каждой стадии соответствует роль агента и «своя» колонка:

| Роль (identity)          | Колонка           | MCP-сервер               | Скилл                            |
|--------------------------|-------------------|--------------------------|----------------------------------|
| `analyst-agent`          | `Analysis`        | `slonk-analyst`          | `skills/slonk-analyst/`          |
| `developer-agent`        | `Development`     | `slonk-developer`        | `skills/slonk-developer/`        |
| `security-auditor-agent` | `Security Review` | `slonk-security-auditor` | `skills/slonk-security-auditor/` |
| `code-review-agent`      | `Code Review`     | `slonk-code-review`      | `skills/slonk-code-review/`      |
| `qa-agent`               | `Testing`         | `slonk-qa`               | `skills/slonk-qa/`               |
| `doc-agent`              | `Documenting`     | `slonk-doc`              | `skills/slonk-doc/`              |
| `merger-agent`           | `Merging`         | `slonk-merger`           | `skills/slonk-merger/`           |

Все ролевые скиллы делят **один канонический цикл** (`CLAUDE.md` → «Жизненный
цикл задачи»): проверить identity → найти задачу в своей колонке → claim →
прочитать контекст и комментарии предыдущих ролей → сделать свою часть →
передать дальше (`transition_issue` + прощальный комментарий). Сам ролевой
SKILL.md — тонкая «дельта» поверх этого цикла: только что именно делать на шаге 5
и куда передавать на шаге 6. **Ролевые скиллы не передают работу спавном агента**
— только через комментарии и перемещение карточки. Задачу из `To Do` забирает
только аналитик (`claim_issue` переносит её в `Analysis`); в `Done` переводит
только `merger-agent` после `Merging`.

### Два способа гонять конвейер

- **По терминалу на роль** (по умолчанию): пользователь открывает несколько
  терминалов, в каждом — один агент под своей identity и своим скиллом; доска
  едет сама, потому что каждая роль двигает карточку дальше. Можно поднять
  несколько агентов на одну роль — задачи в колонке разберутся параллельно (claim
  атомарный, гонку выигрывает один). Чтобы агент крутил свою колонку циклически —
  запускайте скилл через `/loop` (например `/loop 5m работай как разработчик
  slonk: бери задачи из колонки Development`).
- **Один оркестратор** — скилл `slonk-agent`: один терминал ведёт задачу через
  весь конвейер, спавня на каждую стадию субагента под нужной ролью и её скиллом.
  `/slonk-agent` (без аргумента) — drain-режим: гоняет всю доску, пока есть
  работа. `/slonk-agent <issue-id>` — ведёт одну конкретную задачу до `Done`.
  Требует, чтобы были подключены все 7 `slonk-<role>` MCP-серверов (см. ниже) —
  иначе субагенты не смогут работать каждый от своей identity.

## Развёртывание

Предполагается, что стек slonk уже поднят и забутстраплен (см.
[`docs/USER_GUIDE.md`](../USER_GUIDE.md)), и у вас есть `MCP_AUTH_TOKEN`. Тогда:

### 1. Системный промпт

Положите `CLAUDE.md` из этого каталога в системный промпт агента:
- **Claude Code** — в `CLAUDE.md` репозитория-задачи (или `~/.claude/CLAUDE.md`
  для глобальных правил);
- **Claude Desktop** — в поле Custom Instructions;
- **Codex CLI** — в `~/.codex/prompt.md` или аналог.

### 2. Скиллы

Скопируйте каталоги из `skills/` в `.claude/skills/` репозитория-задачи (или в
`~/.claude/skills/` для глобальной доступности). Ролевой скилл активируется, когда
вы говорите агенту работать в соответствующей роли (или вызываете его через
`/loop`); в одном терминале держите один ролевой скилл активным — он должен
совпадать с identity MCP-сервера. Скилл-оркестратор `slonk-agent` вызывается
командой `/slonk-agent` и сам подтягивает ролевые скиллы для субагентов.

### 3. MCP-серверы

Самый быстрый путь (один сервер на запуск Claude Code):

```bash
claude mcp add --transport http slonk-developer http://localhost:8787/mcp \
  --header "Authorization: Bearer $MCP_AUTH_TOKEN" \
  --header "X-Agent-Identity: developer-agent"
```

Либо пропишите все 7 ролей сразу — возьмите `mcpServers` из `docs/claude/.mcp.json`
этого каталога и положите его:
- в `.mcp.json` в корне репозитория-задачи (project scope, можно коммитить —
  токен подставится из окружения через `${MCP_AUTH_TOKEN}`); **или**
- в `~/.claude.json` (user scope) под ключ `mcpServers` — для Claude Code; **или**
- в `claude_desktop_config.json` (Claude Desktop) / `~/.codex/config.toml`
  (Codex CLI), обернув HTTP в `mcp-remote` — см. примеры в
  [`docs/USER_GUIDE.md §5`](../USER_GUIDE.md).

> Важно: identity — на агента, а не на пользователя. Если запускаете несколько
> ролей (или используете `slonk-agent`), заводите **отдельную MCP-запись на
> каждую** с разным `X-Agent-Identity` (как в `docs/claude/.mcp.json`). В Claude
> Code между ними можно переключаться командой `/mcp use slonk-<role>`.
>
> ⚠️ **Никогда не инлайньте реальный `MCP_AUTH_TOKEN` в `.mcp.json`** — только
> плейсхолдер `${MCP_AUTH_TOKEN}`, который Claude Code подставит из окружения.
> Иначе при коммите файла токен утечёт в историю репозитория. По той же причине
> `.mcp.json` в корне репозитория-задачи (project scope) безопасно коммитить
> _только_ с плейсхолдером; `~/.claude.json` (user scope) не коммитится в принципе.

### 4. Создайте задачу

В Plane UI создайте issue в проекте slonk, состояние `To Do`, лейбл
`agent-ready` (обязательный маркер «бери в работу»). Дальше аналитик подхватит
её и задача поедет по конвейеру. Подробнее — `docs/USER_GUIDE.md §6.3`.

## Ссылки

- Полная инструкция по установке/настройке/обучению агентов — [`docs/USER_GUIDE.md`](../USER_GUIDE.md).
- Контракт MCP API и workflow — [`docs/SPEC.md`](../SPEC.md).
- Конвенции репозитория — [`docs/CONVENTIONS.md`](../CONVENTIONS.md).
