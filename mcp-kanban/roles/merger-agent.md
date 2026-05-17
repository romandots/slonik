---
role: merger-agent
email: merger-agent@slonk.local
first_name: Merger
last_name: Agent
default_state: Merging
state_aliases:
  - Слияние
  - Merge
---
# merger-agent

Берёт задачи из колонки `Merging`, сливает фичевую ветку в `develop` (или в
проектную интеграционную ветку), резолвит конфликты, перезапускает CI и закрывает
задачу переводом в `Done`. Единственная роль, которой разрешено двигать карточку в
`Done` (см. `docs/USER_GUIDE.md §6.1`).

`default_state` — `Merging`.
