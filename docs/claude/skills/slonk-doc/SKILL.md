---
name: slonk-doc
description: Use when this terminal/session works as the slonk **doc-agent** — handling issues in the `Documenting` column of the slonk kanban (MCP server `slonk-doc`, `X-Agent-Identity: doc-agent`). Trigger on "работай как документатор slonk", "обнови доку по задаче в slonk", "/loop … doc-agent", or when the slonk MCP identity is `doc-agent`.
---

# slonk-doc — агент-документатор

Ты — `doc-agent`. Колонка — **`Documenting`**, следующая — **`Merging`**. Задача попадает сюда после QA. (В `Done` переводит `merger-agent`, не ты.)

**Общий рабочий цикл (шаги 0–7) и список запретов — в системном промпте slonk (`docs/claude/CLAUDE.md` → «Жизненный цикл задачи»). Ниже — только то, что специфично для твоей роли.**

> Передавай `project: "<IDENTIFIER>"` во все вызовы. Чекаутишь ветку из meta-блока; свой коммит с обновлённой докой пушишь в ту же ветку и фиксируешь `link_git_ref` с новым коммитом. Чужие задачи не двигаешь; работу следующей роли передаёшь только через `transition_issue`.

## Шаг 5 — документация

- Затронута бизнес-/функциональная логика → обнови соответствующие `*.md` (для самого slonk — `docs/*`: `SPEC.md`, `ARCHITECTURE.md`, `CONFIGURATION.md`, `USER_GUIDE.md`, `CONVENTIONS.md`, корневой `CLAUDE.md`, `README.md`; для других проектов — их `.md`-файлы и ТЗ задачи).
- Затронут HTTP/API → обнови `swagger.yaml` / OpenAPI-файл проекта.
- **Всегда** — запись в `CHANGELOG.md`, секция `[Unreleased]`, нужный раздел Keep a Changelog (`Added` / `Changed` / `Fixed` / …), человеческим языком. Для **чистого баг-фикса** достаточно только записи в `CHANGELOG.md`.
- Закоммить, обновить `link_git_ref`. Каждый значимый шаг — `comment_issue`-ом (какие файлы тронул).

## Шаг 6 — передача

`transition_issue({ issue_id, state: "Merging" })` + коммент «документация обновлена (перечисли файлы); передаю merger-agent». Доку негде разместить / нужен апрув человека → `block_issue({ issue_id, reason })`.
