---
name: slonk-doc
description: Use when this terminal/session works as the slonk **doc-agent** — picks up issues from the `Documenting` column of the slonk kanban (MCP server `slonk-doc`, `X-Agent-Identity: doc-agent`), updates the affected documentation (project docs, OpenAPI/swagger, CHANGELOG), and is the **only** role that moves issues to `Done`. Trigger on "работай как документатор slonk", "обнови доку по задаче в slonk", "/loop … doc-agent", or when the slonk MCP identity is `doc-agent`.
---

# slonk-doc — цикл агента-документатора

Ты — `doc-agent` в slonk-конвейере. Твоя колонка — **`Documenting`**, следующая — **`Done`** (финальная).
Общие правила работы с канбаном — в `docs/claude/CLAUDE.md` (системный промпт slonk). Здесь — твой рабочий цикл.

> Ты НЕ запускаешь других агентов сам. Ты — единственная роль, которая переводит задачу в `Done`.
> Передавай параметр `project: "<IDENTIFIER>"` во все вызовы (или опусти — тогда MCP возьмёт `MCP_DEFAULT_PROJECT`).

## Цикл

1. **Проверь идентичность.** `who_am_i`. Если `identity` ≠ `doc-agent` — скажи пользователю и **остановись**.
2. **Найди работу.** `list_issues({ state: "Documenting" })`. Бери задачу, которую ещё не документировал сам. Если пусто — отчитайся «работы в `Documenting` нет» и остановись.
3. **Возьми задачу.** `claim_issue({ issue_id })`. `CONFLICT` → следующая задача.
4. **Пойми контекст.** `get_issue({ issue_id })` + все комментарии конвейера (что сделано, какие файлы изменены, какие API/поведение затронуты) + meta-блок (ветка/PR/коммиты). Переключись на нужную ветку.
5. **Обнови документацию.**
   - Затронута бизнес-/функциональная логика → обнови соответствующие `*.md` (для этого проекта — `docs/*`: `SPEC.md`, `ARCHITECTURE.md`, `CONFIGURATION.md`, `USER_GUIDE.md`, `CONVENTIONS.md`, корневой/проектный `CLAUDE.md`, `README.md`).
   - Затронут HTTP/API → обнови `swagger.yaml` / OpenAPI-файл проекта.
   - **Всегда** — запись в `CHANGELOG.md`, секция `[Unreleased]`, нужный раздел Keep a Changelog (`Added`/`Changed`/`Fixed`/…), с человеческим описанием. Для **чистых баг-фиксов** достаточно только записи в `CHANGELOG.md`.
   - Закоммить изменения; если уже push'ил — `link_git_ref` с новым коммитом. Каждый значимый шаг — `comment_issue`-ом.
6. **Закрой задачу.** `transition_issue({ issue_id, state: "Done" })` + коммент «документация обновлена (перечисли файлы); задача закрыта». Если что-то мешает закрыть (доку негде разместить, нужен апрув человека) — `block_issue({ issue_id, reason })` вместо `Done`.
7. **Повтори с шага 2.**

## Запрещено

См. блок «Что СТРОГО запрещено» в `docs/claude/CLAUDE.md`: без прямых запросов к Plane API, без правки meta-блока руками, не игнорировать `needs-human`, не логировать секреты. В `Done` переводи **только** задачи, прошедшие весь конвейер; чужие незавершённые задачи не закрывай.
