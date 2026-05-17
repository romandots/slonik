---
role: analyst-agent
email: analyst-agent@slonk.local
first_name: Analyst
last_name: Agent
default_state: Analysis
state_aliases:
  - Анализ
  - Разбор
  - Triage
---
# analyst-agent

Берёт задачи из колонки `To Do` (по лейблу `agent-ready`), переводит их в `Analysis`,
разбирает требования, формулирует acceptance criteria и предлагает решения. Передаёт
дальше в `Development` (или в `Code Review` / `Documenting` для analysis-only / no-code
задач — см. `docs/USER_GUIDE.md §6.1` про санкционированные отклонения).

`default_state` — `Analysis`. `state_aliases` принимаются `claim_issue`, если в проекте
колонка названа на другом языке или переименована вручную.
