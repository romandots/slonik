# Security policy — slonk

Этот документ — короткий summary security-постуры slonk на v1.0. Детальный
threat model — [ARCHITECTURE.md §9](./docs/ARCHITECTURE.md#9-модель-угроз),
требования к секретам, токенам, изоляции — [SPEC.md §8](./docs/SPEC.md#8-безопасность).

## Поддерживаемые версии

| Версия | Поддержка |
|---|---|
| 1.0.x | ✅ активно |
| < 1.0 | ❌ не поддерживается |

## Сообщение об уязвимости

slonk — self-hosted продукт. Найденные уязвимости докладывать **приватно**
через issue с лейблом `security` в репозиторий проекта; для critical-уровня —
напрямую мейнтейнеру (см. `git log` для контактов).

Не публикуйте детали эксплойта до выхода патча: ваш инстанс под угрозой
не только до релиза, но и в окно от disclosure до обновления у каждого
оператора.

## Базовые гарантии v1.0

Эти инварианты проверяются acceptance-критериями ([SPEC.md §10](./docs/SPEC.md#10-acceptance-criteria-для-v10))
и должны соблюдаться в любом production-развёртывании.

### Сеть и публикация портов

- `internal_net` объявлена без `external: true` и не публикует ни одного
  порта на хост. Постгрес/Valkey/RabbitMQ/MinIO/plane-api — наружу не торчат.
- `public_net` публикует только то, что нужно агенту: `plane-proxy:80` (HTTP
  dev) или `caddy:80/443` (HTTPS prod, через `docker-compose.proxy.yml`).
- `MCP_ALLOW_CIDR` ограничивает источник входящих запросов к MCP.

### Секреты

- Все секреты — в `.env`. В git коммитится только `.env.example` с
  заглушками. `.gitignore` гарантирует, что `.env` не уходит наверх.
- `MCP_AUTH_TOKEN` обязательно ≥ 32 байт энтропии; config.ts отказывается
  стартовать с `change_me` или слабым значением.
- `PLANE_API_KEY`, `MCP_AUTH_TOKEN`, `*_PASSWORD`, presigned URLs —
  редактируются pino-логгером (`src/logger.ts`).
- Bearer-токен сравнивается timing-safely (`src/auth.ts`).

### Аутентификация и identity

- Все эндпоинты кроме `/health` (и `/metrics`, гейтнутого env'ом)
  требуют `Authorization: Bearer <MCP_AUTH_TOKEN>`.
- Каждый MCP-вызов требует `X-Agent-Identity: <role>` с whitelist'ом ролей
  (`src/identity.ts` — 6 ролей из bootstrap-манифеста).
- Identity, не входящая в whitelist → `IDENTITY_REQUIRED` 400, **без**
  обращения к Plane.

### Концурентность и атомарность

- `claim_issue` — единственная точка serialization: SQLite UNIQUE-constraint
  на `claim_lock.issue_id`. Параллельные `claim_issue` от двух identity на
  одну задачу гарантируют ровно 1 успех + 1 `CONFLICT` (Phase 5,
  `claim-issue/handler.test.ts`).
- Rate-limit: глобальный + per-identity token bucket
  (`MCP_RL_GLOBAL_RPS`/`MCP_RL_IDENTITY_RPS`). Превышение → `RATE_LIMITED`
  + audit-запись.

### Хранилище MCP

- `mcp_data/audit.sqlite` — журнал всех write-операций (`trace_id`, identity,
  tool, input_hash, outcome). `input_hash` — SHA-256(stable-JSON входа), **не**
  сырой payload. Никаких токенов и presigned URL в audit не пишется.
- `mcp_data/git_refs.sqlite` — индекс git-привязок. Не содержит секретов.
- `mcp_data/identity.sqlite` — маппинг agent role → plane_user_id.
  Plane-user_id — публичный идентификатор Plane, не секрет.

### Объектное хранилище и attach_file

- `attach_file` использует presigned PUT в MinIO (TTL =
  `PLANE_SIGNED_URL_EXPIRATION`, default 1ч). MCP сам файлы не принимает.
- Bucket'ы изолированы: `MINIO_BUCKET_PLANE` (Plane uploads), `MINIO_BUCKET_MCP`
  (MCP artifacts). Presigned URL выдаётся только аутентифицированной
  identity.

### Recovery

- Повреждённый `<!-- slonk:meta v1 -->` блок **не удаляется** —
  `preserveCorruptDescription` пакует его в fenced-quote, поверх пишется
  свежий блок, ставится лейбл `needs-human` (Phase 6).
- `unlink_git_ref` на повреждённом блоке возвращает `CONFLICT` (не пытается
  угадать).
- При сбое Plane-PATCH'а во время `claim_issue` SQLite claim откатывается —
  повторный вызов возможен.

## Что v1.0 НЕ покрывает

- Multi-tenant. Один MCP — одна команда / workspace.
- Per-agent OAuth: все идентичности шарят общий `MCP_AUTH_TOKEN`,
  различаются только заголовком `X-Agent-Identity`. Token compromise =
  доступ от всех ролей.
- Endpoint-сигнатуры/HSM. Все секреты — в plaintext `.env`.
- Internal-CA-pinning для Caddy `tls internal`: клиенты должны вручную
  доверять root CA из тома `slonk_caddy_data`.

Эти ограничения зафиксированы в [ROADMAP.md «После v1.0 — кандидаты»](./docs/ROADMAP.md#после-v10--кандидаты).
