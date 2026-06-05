# Дизайн: встроенный OAuth 2.1 Authorization Server для remote-коннектора claude.ai

- **Дата:** 2026-06-05
- **Статус:** утверждён (брейншторм)
- **Контекст:** `mcp-kanban` сейчас аутентифицирует запросы статичным
  pre-shared Bearer-токеном (`MCP_AUTH_TOKEN`) + кастомным заголовком
  `X-Agent-Identity` (см. [`src/auth.ts`](../../../mcp-kanban/src/auth.ts)).
  Этого достаточно для локальных агентов с прошитыми заголовками, но claude.ai
  при добавлении remote-коннектора через UI требует полноценный OAuth 2.1 flow
  с PKCE и OAuth-discovery. Roadmap уже закладывал направление
  («Per-agent OAuth-токены вместо общего `MCP_AUTH_TOKEN`», [ROADMAP.md:306](../../ROADMAP.md)).

## Цель

Дать возможность добавить self-hosted slonk как **remote-коннектор на
claude.ai**: человек вставляет публичный URL сервера, проходит OAuth-логин и
дирижирует своим канбаном через чат claude.ai. Транспорт (Streamable HTTP,
`StreamableHTTPServerTransport`, `ALL /mcp`) уже реализован и доработок не
требует — задача только про авторизацию.

## Ключевые решения (из брейншторма)

1. **Драйвер — сценарий A:** публичный remote-коннектор для claude.ai (не
   per-agent токены для локальных агентов).
2. **Authorization Server — встроенный в `mcp-kanban`** (вариант A): сервер
   совмещает роли Resource Server и Authorization Server в одном процессе.
   Никаких внешних IdP — в духе «один `docker compose up` поднимает всё».
3. **OAuth-вход мапится на отдельную identity `operator`** (вариант A) с
   полным доступом, не привязанную к конвейерной колонке. claude.ai-сессия =
   живой человек, а не агент конвейера. `X-Agent-Identity` остаётся как есть
   для локальных агентов — обе схемы сосуществуют.
4. **Аутентификация оператора на `/authorize` — вводом текущего
   `MCP_AUTH_TOKEN`** как пароля (вариант C). Новый секрет не заводим.
5. **Токены — opaque + SQLite** (вариант A): мгновенный revoke, ноль ключей
   подписи, ложится на существующую `better-sqlite3`-инфраструктуру. Короткий
   access + длинный refresh с ротацией.
6. **Dynamic Client Registration — открытый** (вариант A) с cap + rate-limit:
   «вставил URL в claude.ai → работает». Реальная преграда — operator-пароль
   на `/authorize`.

## Архитектура

`mcp-kanban` совмещает Resource Server (защищённый `/mcp`) и Authorization
Server (логин + выдача токенов) в одном процессе.

- Новый функциональный модуль `src/oauth/` — чистое ядро (валидация PKCE,
  генерация/хэширование токенов, проверка redirect_uri, формирование metadata)
  + Fastify-хендлеры на краях, по конвенции проекта.
- Новое SQLite-хранилище `oauth.sqlite` через класс `OAuthStore`
  (`better-sqlite3`, паттерн `audit.ts` / `git-refs.ts` / `IdentityStore`).
- Вся фича за фиче-флагом **`MCP_OAUTH_ENABLED`** (default `false`):
  - выключено → текущее поведение не меняется ни на байт; OAuth-эндпоинты
    отдают 404;
  - включено → добавляются OAuth-эндпоинты, а `/mcp` принимает **оба** типа
    Bearer: статичный `MCP_AUTH_TOKEN` (локальные агенты) **и** OAuth
    access-токен (claude.ai → identity `operator`).

**Предусловие (вне скоупа задачи):** claude.ai ходит только по HTTPS на
публичный URL. TLS-терминация — это внешний Caddy (Phase 7) + публичный домен.
Реализацию TLS сюда не тащим, но фиксируем как обязательное операционное
требование в доках.

## HTTP-эндпоинты (на том же Fastify-приложении)

| Метод + путь | Назначение | Auth |
|---|---|---|
| `GET /.well-known/oauth-protected-resource` | RFC 9728 — метаданные Resource Server, указывают на AS (этот же сервер) и `resource` URI | публичный |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 — метаданные AS: `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `code_challenge_methods_supported: ["S256"]`, `grant_types_supported: [authorization_code, refresh_token]` | публичный |
| `POST /oauth/register` | RFC 7591 DCR — открытый, cap `MCP_OAUTH_MAX_CLIENTS` + rate-limit; принимает `redirect_uris`, `client_name`; возвращает `client_id` (public client, без секрета — PKCE обязателен) | публичный |
| `GET /oauth/authorize` | Рендерит HTML-форму логина (одно поле — operator-пароль). Заранее валидирует `client_id`, точное совпадение `redirect_uri`, `code_challenge` + `code_challenge_method=S256`, `state`, `resource` | публичный |
| `POST /oauth/authorize` | Проверяет пароль (= `MCP_AUTH_TOKEN`, constant-time). Успех → выдаёт authorization code (single-use, TTL `MCP_OAUTH_CODE_TTL_SEC`, привязан к client/redirect_uri/code_challenge/identity/resource), редирект на `redirect_uri?code=…&state=…` | форма |
| `POST /oauth/token` | `grant_type=authorization_code` (проверка PKCE `code_verifier` → `S256`) и `grant_type=refresh_token` (ротация). Возвращает opaque `access_token` + `refresh_token` + `expires_in` + `token_type=Bearer` | client_id + PKCE |
| `POST /oauth/revoke` | RFC 7009 — отзыв access/refresh токена | client_id |

**Поток для claude.ai:** discovery → `POST /register` → `GET /authorize`
(человек вводит operator-пароль) → authorization code → `POST /token` →
access + refresh → дальше `/mcp` с `Authorization: Bearer <access>`.

## Хранилище (`oauth.sqlite`, класс `OAuthStore`)

Токены и коды хранятся **только в виде SHA-256-хэша**. Плейнтекст не пишем
никуда; в логах редактируем (расширим `pino` redact-список).

```
oauth_clients
  client_id PK, client_name, redirect_uris (JSON массив),
  token_endpoint_auth_method, created_at
  -- cap MCP_OAUTH_MAX_CLIENTS enforced на insert

oauth_codes
  code_hash PK, client_id, redirect_uri, code_challenge,
  identity, scope, resource, expires_at, used (0/1)
  -- single-use: атомарный UPDATE ... WHERE used=0 (паттерн claim_lock)

oauth_tokens
  token_hash PK, kind ('access'|'refresh'), client_id,
  identity, scope, resource, expires_at, refresh_chain_id
```

**Ротация refresh:** при `grant_type=refresh_token` старый refresh помечается
использованным и выдаётся новая пара. Повторное использование отозванного
refresh → инвалидируем всю цепочку (`refresh_chain_id`) как признак кражи
токена (OAuth 2.1 / RFC 6819).

**identity → Plane:** tools ассайнят задачи на `plane_user_id` identity.
`operator` получает `plane_user_id` по умолчанию = владелец `PLANE_API_KEY`
(тот же пользователь, что в `single_bot`-fallback); оператор может задать явный
через identity-стор. `operator` добавляется в реестр identity как роль без
конвейерной колонки (полный доступ на чтение/переходы).

## Интеграция с существующей аутентификацией

`src/auth.ts` расширяется: при `MCP_OAUTH_ENABLED` Bearer на `/mcp` может быть
либо статичным `MCP_AUTH_TOKEN` (как сейчас — identity из `X-Agent-Identity`),
либо OAuth access-токеном (lookup по хэшу в `OAuthStore` → identity берётся из
токена, `X-Agent-Identity` игнорируется). Обратная совместимость полная.
Валидация OAuth-токена кэшируется через существующий `TtlCache`, чтобы не
читать SQLite на каждый вызов (с инвалидацией при revoke).

## Конфиг (новые ENV, все опциональные при выключенном флаге)

```
MCP_OAUTH_ENABLED           Bool, default false  — главный фиче-флаг
MCP_OAUTH_ISSUER            url   — публичный base URL (metadata/redirect), напр. https://slonk.example.com
                                    обязателен при MCP_OAUTH_ENABLED=1 (zod refine)
MCP_OAUTH_OPERATOR_IDENTITY str,  default "operator"
MCP_OAUTH_ACCESS_TTL_SEC    int,  default 3600
MCP_OAUTH_REFRESH_TTL_SEC   int,  default 2592000 (30 дней)
MCP_OAUTH_CODE_TTL_SEC      int,  default 60
MCP_OAUTH_MAX_CLIENTS       int,  default 50
MCP_OAUTH_STORE_PATH        opt,  default /mcp_data/oauth.sqlite
```

Отдельной переменной для operator-пароля нет — переиспользуется
`MCP_AUTH_TOKEN`.

## Безопасность

- PKCE `S256` обязателен; `plain` отклоняется.
- Точное (exact-match) сравнение `redirect_uri`.
- Authorization codes single-use + короткий TTL.
- `state` pass-through (защита от CSRF на стороне клиента).
- `resource` (RFC 8707) привязывает аудиторию токена к этому Resource Server;
  токен, выданный под другой resource, на `/mcp` не принимается.
- Constant-time сравнение operator-пароля (готовое из `auth.ts`).
- Rate-limit на `/oauth/register`, `/oauth/authorize`, `/oauth/token`
  (существующий `RateLimiter`).
- Хэш токенов и кодов в покое (SHA-256); redact в логах.
- Cap числа OAuth-клиентов (`MCP_OAUTH_MAX_CLIENTS`).
- TLS — операционное предусловие (внешний Caddy), без него claude.ai не
  подключится.

## Тестирование (vitest)

- Юнит-тесты на каждый хендлер и на чистое ядро (PKCE-проверка, хэширование,
  metadata-генерация, exact-match redirect_uri).
- Полный integration-флоу: register → authorize (пароль) → code → token →
  вызов `/mcp` с access-токеном → refresh → ротация → revoke.
- Негативные сценарии: неверный `code_verifier`; протухший код; повторное
  использование кода; чужой/несовпадающий `redirect_uri`; неверный
  operator-пароль; повторное использование отозванного refresh →
  инвалидация цепочки; `MCP_OAUTH_ENABLED=false` → OAuth-эндпоинты отдают 404
  и `/mcp` работает по-старому.

## Вне скоупа

- Внешний IdP / делегирование авторизации.
- Per-agent OAuth-токены для локальных агентов (остаются на
  `X-Agent-Identity`).
- Сама TLS-терминация (это Caddy, Phase 7).
- Мульти-юзер / несколько operator-идентичностей с разными правами.

## Версионирование и документация

- SemVer: новая обратносовместимая функциональность (фича за выключенным по
  умолчанию флагом) → **MINOR bump** (`1.5.0` → `1.6.0`).
- Документация по итогам реализации обновляется в:
  `docs/SPEC.md` (контракт auth, новые эндпоинты, коды ошибок),
  `docs/ARCHITECTURE.md` (потоки данных, модель угроз),
  `docs/CONFIGURATION.md` (новые ENV), `docs/ROADMAP.md` (закрытие пункта),
  `docs/CHANGELOG.md` (запись в `[Unreleased] → Added`), `.env.example`.
