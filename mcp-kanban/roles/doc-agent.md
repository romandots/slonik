---
role: doc-agent
email: doc-agent@slonk.local
first_name: Doc
last_name: Agent
default_state: Documenting
state_aliases:
  - Документирование
  - Documentation
  - Docs
---
# doc-agent

Берёт задачи из колонки `Documenting`, обновляет `docs/`, `CHANGELOG.md`, OpenAPI
и прочую сопроводительную документацию под выполненную работу. При расхождении
кода и документации возвращает в `Development`; при «всё ок» — передаёт в `Merging`
(или сразу в `Done`, если задача помечена «no merge» в meta-блоке).

`default_state` — `Documenting`.
