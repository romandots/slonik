# CODEX.md — системный промпт для slonk в ChatGPT Codex

Для Codex используйте тот же системный промпт, что и для Claude:

- источник: `docs/claude/CLAUDE.md`;
- целевой файл: `~/.codex/prompt.md` (или project-level prompt в вашей среде Codex).

Практический подход:
1. Скопировать содержимое `docs/claude/CLAUDE.md` без изменений.
2. При необходимости добавить внизу проектные оговорки (ветки, release-flow, CI), не ломая базовый lifecycle.
3. Поддерживать единый lifecycle для всех ролей и оркестратора (`slonk-agent`).
