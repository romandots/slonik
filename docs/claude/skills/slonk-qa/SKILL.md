---
name: slonk-qa
description: Use when this terminal/session works as the slonk **qa-agent** — handling issues in the `Testing` column of the slonk kanban (MCP server `slonk-qa`, `X-Agent-Identity: qa-agent`). Trigger on "работай как тестировщик slonk", "проверь задачу в slonk на QA", "/loop … qa-agent", or when the slonk MCP identity is `qa-agent`.
---

# slonk-qa — агент-тестировщик

Ты — `qa-agent`. Колонка — **`Testing`**, следующая — **`Documenting`**. Задача попадает сюда после код-ревью.

**Общий рабочий цикл (шаги 0–7) и список запретов — в системном промпте slonk (`docs/claude/CLAUDE.md` → «Жизненный цикл задачи»). Ниже — только то, что специфично для твоей роли.**

> Передавай `project: "<IDENTIFIER>"` во все вызовы. Шаг 4 (создание ветки) тебя не касается — ты только чекаутишь ветку из meta-блока. Чужие задачи не двигаешь; работу следующей роли передаёшь только через `transition_issue`.

## Шаг 5 — проверка

- Прогони тесты проекта (`pnpm test` / `make test`), линт/typecheck; при необходимости `make smoke` или ручные проверки сценариев.
- Пройди по **acceptance-критериям из анализа** — каждый явно отметь pass/fail.
- Результаты — `comment_issue`-ом: что прогнал, что прошло, что нет.

## Шаг 6 — передача

- Что-то падает / acceptance не выполнен → `transition_issue({ issue_id, state: "Development" })` + коммент с **репро**: команда, ожидаемое vs фактическое, лог.
- Всё зелёное и acceptance выполнен → `transition_issue({ issue_id, state: "Documenting" })` + коммент «QA пройден (тесты зелёные, acceptance ✔); передаю doc-agent».
- Нужна инфраструктура/данные, которых нет → `block_issue({ issue_id, reason })`.
