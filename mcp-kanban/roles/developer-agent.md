---
role: developer-agent
email: developer-agent@slonk.local
first_name: Developer
last_name: Agent
default_state: Development
state_aliases:
  - Разработка
  - Написание кода
  - Coding
  - In Progress
---
# developer-agent

Берёт задачи из колонки `Development` (после аналитика), пишет код по acceptance
criteria, прогоняет тесты/линтер, оформляет ветку и коммиты по проектным конвенциям,
передаёт задачу в `Security Review` (или в `Code Review` для не security-sensitive
изменений — см. `docs/USER_GUIDE.md §6.1`).

`default_state` — `Development`.
