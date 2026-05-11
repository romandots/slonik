# Changelog

Все значимые изменения в slonk фиксируются в этом файле.

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версионирование — [Semantic Versioning](https://semver.org/lang/ru/).

## [Unreleased]

### Added
- Документация проекта (`README.md`, `SPEC.md`, `ARCHITECTURE.md`,
  `CONFIGURATION.md`, `ROADMAP.md`, `CONVENTIONS.md`, `CHANGELOG.md`),
  собранная из исходного `BRIEF.md`.
- Зафиксирован выбор стека MCP-сервера: TypeScript на Node.js 20 LTS с
  `@modelcontextprotocol/sdk`, `fastify`, `zod`, `better-sqlite3`, `pino`
  (см. [CONVENTIONS.md §2](./CONVENTIONS.md#2-стек-mcp-server)).
- Зафиксирован поэтапный план реализации (Phase 0…10) с критериями приёмки
  (см. [ROADMAP.md](./ROADMAP.md)).
- Зафиксирован контракт MCP API: 19 инструментов, схемы параметров,
  обработка ошибок, идемпотентность, rate limiting, аудит
  (см. [SPEC.md §6](./SPEC.md#6-mcp-server-api)).
- Зафиксирована схема git-интеграции через машинно-читаемый блок
  `<!-- slonk:meta v1 -->` в описании задачи + SQLite-индекс
  (см. [SPEC.md §5.6](./SPEC.md#56-привязка-к-репозиториям)).
- Зафиксирована модель угроз и базовая модель безопасности
  (см. [ARCHITECTURE.md §9](./ARCHITECTURE.md#9-модель-угроз),
  [SPEC.md §8](./SPEC.md#8-безопасность)).
- Зафиксирована стратегия agent identity с двумя режимами: `per_user`
  (по умолчанию) и `single_bot` (fallback) — параметр
  `MCP_AGENT_IDENTITY_MODE` (см. [SPEC.md §5.5](./SPEC.md#55-agent-identity)).

### Decisions
- **Stack:** TypeScript/Node для MCP — выбран ради зрелого MCP SDK и нативной
  JSON-работы с Plane REST. Альтернативы (Python/Go) отложены.
- **Storage:** локальный SQLite внутри MCP для audit-log, git-refs-индекса
  и identity-маппинга. Никаких внешних БД для MCP — это снижает связность
  с Plane-инфрой.
- **Транспорт MCP:** HTTP+SSE как основной, stdio как опциональный (для
  CLI-агентов и локальной отладки).
- **Меta-блок в описании задачи:** строгий YAML после маркера, идемпотентный
  writer, не разрушает чужой контент при коррупции (ставит `needs-human`).

### Pending
- Выбор лицензии (решается перед v1.0.0).
- Окончательная фиксация digest'ов upstream-образов Plane (Phase 1).
- Webhook-реактор и автоматизация переходов — после v1.0.

---

## История релизов

Релизных версий пока нет. Первая запланированная — `v0.1.0` после завершения
Phase 1 (Plane stack поднимается). См. [ROADMAP.md](./ROADMAP.md).

<!--
Шаблон будущей записи:

## [X.Y.Z] — YYYY-MM-DD

### Added
- …

### Changed
- **BREAKING:** … (если есть)
- …

### Fixed
- …

### Removed
- …

### Security
- …
-->
