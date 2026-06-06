# SLONK-18 — Multitenant-режим slonk: CLI `add-tenant` + multi-workspace bootstrap

> Техническое задание. Источник правды по поведению — после реализации
> переносится в `docs/SPEC.md`, `docs/CONFIGURATION.md`, `docs/USER_GUIDE.md`.

## 1. Цель

Дать оператору slonk инструменты для эксплуатации уже реализованной (SLONK-15)
multitenant-инфраструктуры:

1. **Operator-CLI `add-tenant`** — регистрация/обновление тенанта (workspace +
   Plane API-ключ + пароль для OAuth-логина) в OAuth-сторе `oauth.sqlite`.
2. **Multi-workspace bootstrap** — инициализация states/labels/identities в
   Plane-workspace произвольного тенанта (не только дефолтного `agents`),
   используя API-ключ этого тенанта.
3. **Документация** оператора по multitenant-рабочему циклу.

Реальные тенанты оператор заводит позже сам через CLI; задача — спроектировать
и реализовать механизм с демонстрацией через документированный сценарий.

## 2. Подтверждённые решения

| # | Решение | Выбор |
|---|---|---|
| 1 | Запуск `add-tenant` | **Контейнерный** (`docker compose run --rm mcp-kanban node dist/server.js add-tenant ...`); локальный через `--store` — альтернатива |
| 2 | API-key для `bootstrap --workspace X` без флага | **Флаг/ENV**; автоподхват `tenant.plane_api_key` из стора — отдельный follow-up |
| 3 | Минимальная длина ручного пароля тенанта | **≥8** символов |
| 4 | Demo-тенант | **Только инструкция** в docs, без хардкода в manifest/коде |

## 3. Что уже реализовано (опора, НЕ переделывать)

- OAuth 2.1 AS включён (`MCP_OAUTH_ENABLED=true`). Код: `mcp-kanban/src/oauth/`.
- Таблица `tenants`: `mcp-kanban/src/oauth/store.ts` — `registerTenant()`
  (ON CONFLICT DO UPDATE), `getTenantByWorkspace()`, `getTenantByAuthTokenHash()`,
  `listTenants()`. Поля: `workspace, plane_api_key, auth_token_hash, max_clients,
  created_at_ms`.
- `hashToken()` = SHA-256 hex: `mcp-kanban/src/oauth/crypto.ts`. Этим же хэшем
  пароль сверяется в `routes.ts` и регистрируется в `server.ts`.
- Авто-регистрация дефолтного тенанта: `server.ts` (`oauth.registerTenant` для
  `MCP_DEFAULT_WORKSPACE`).
- Per-workspace PlaneClient: `server.ts` `getPlaneClient(workspace)`.
- Per-tenant пароль на `/oauth/authorize?workspace=<name>`: `routes.ts`.
- Инвариант безопасности: workspace берётся ТОЛЬКО из access-токена (`auth.ts`).

## 4. CLI `add-tenant`

### Файлы (новые)
- `mcp-kanban/src/bootstrap/add-tenant.ts`
- `mcp-kanban/src/bootstrap/add-tenant.test.ts`

### Интерфейс
`addTenantCli(opts): Promise<AddTenantResult>` (по образцу `addRoleCli`).
DI-хуки для тестов: `store?: OAuthStore`, `now?: () => number`,
`input`/`output`-стримы, `prefill`.

### Флаги
| Флаг | Обяз. | Значение |
|---|---|---|
| `--workspace <slug>` | да | slug Plane-workspace тенанта |
| `--plane-api-key <key>` | да | workspace-scoped Plane API-ключ |
| `--password <pass>` | нет | пароль (≥8); если опущен — генерируется и печатается один раз |
| `--max-clients <n>` | нет | per-tenant cap (default `MCP_OAUTH_MAX_CLIENTS`) |
| `--store <path>` | нет | путь к `oauth.sqlite` |
| `-h, --help` | — | USAGE |

Оба обязательных флага → non-interactive. Иначе — интерактивный сбор.

### Валидация (zod `TenantInputSchema`)
- `workspace`: `min(1)` + slug-regex `^[a-z0-9][a-z0-9-]*$` (не строже, чем Plane).
- `plane_api_key`: `min(1)`, не логировать.
- `password`: `min(8).optional()`.
- `max_clients`: `coerce.number().int().positive().optional()`.

### Алгоритм
1. parseArgs (по образцу `add-role.ts`).
2. Резолв `storePath`: `--store` → `opts.storePath` → `MCP_OAUTH_STORE_PATH` →
   `/mcp_data/oauth.sqlite`. `loadConfig()` в try/catch (дефолты при отсутствии ENV).
3. Собрать `TenantInput`, `TenantInputSchema.parse`.
4. Пароль: `generated = password ? undefined : generateOpaqueToken()`;
   `effectivePassword = password ?? generated`.
5. Открыть `OAuthStore` (или взять `opts.store`).
6. `created = getTenantByWorkspace(workspace) === undefined` (до записи).
7. `registerTenant({ workspace, plane_api_key, auth_token_hash:
   hashToken(effectivePassword), max_clients?, created_at_ms: now() })`.
8. `store.close()` в `finally` (если не DI).
9. Summary через `output`-стрим (НЕ pino): workspace, created/updated, путь.
   Сгенерированный пароль — ровно один раз с пометкой «shown once». API-key
   никогда не печатается обратно. Подсказка про bootstrap workspace и рестарт.

### Идемпотентность
`registerTenant` — `ON CONFLICT(workspace) DO UPDATE`; `created_at_ms` в UPDATE
не трогается. Повторный вызов → `updated`.

### Dispatch + Makefile
- `server.ts dispatch()` — ветка `add-tenant` (`await import('./bootstrap/add-tenant.js')`).
- `Makefile` — цель `add-tenant` (контейнерный запуск, `$(ARGS)`), `.PHONY`.

## 5. Multi-workspace bootstrap

Параметризация существующего bootstrap (без отдельной команды).

- `mcp-kanban/src/bootstrap/cli.ts` — `BootstrapCliOptions` + `workspaceSlug?`,
  `planeApiKey?`; парсинг `--workspace`/`--plane-api-key`. Если `planeApiKey`
  задан — `new PlaneClient({ config: { ...config, PLANE_API_KEY: planeApiKey } })`.
  Источник ключа: флаг → ENV (автоподхват из стора — follow-up).
- `mcp-kanban/src/bootstrap/runner.ts` — `RunnerDeps.workspaceSlugOverride?`;
  локальная `const workspaceSlug = deps.workspaceSlugOverride ??
  manifest.workspace.slug;` вместо `manifest.workspace.slug` во всех вызовах
  (НЕ мутировать manifest).
- `server.ts dispatch()` — прокинуть `process.argv.slice(3)` в `bootstrapCli`.

Без флагов — поведение байт-в-байт прежнее (backward compat).

## 6. Контракт ошибок

`add-tenant` (exit ≠ 0): отсутствует обязательный флаг без TTY; невалидный
slug/пустой ключ/короткий пароль (zod); стор недоступен; неизвестный аргумент.
bootstrap — ошибки как сейчас + `ensureWorkspace` если workspace не найден по ключу.

## 7. Тесты (vitest, ≥70%)

`add-tenant.test.ts`:
1. Non-interactive с `--password` → записан, `auth_token_hash === hashToken(pass)`,
   `created === true`.
2. Без `--password` → `generatedPassword` определён, хэш совпадает.
3. Идемпотентность: 2× с разными ключами → один ряд, обновлён, `created === false`.
4. Интерактив через `PassThrough`.
5. Валидация: пустой workspace/ключ/пароль < 8 → throw.
6. Неизвестный флаг → throw + USAGE.
7. Секреты: в `output` нет plane_api_key; пароль — ровно один раз.
8. `--max-clients` прокинут.

`runner` (если есть тест — расширить): `workspaceSlugOverride` используется;
без override — регрессия прежнего поведения.

Проверка: `pnpm typecheck && pnpm lint && pnpm test` зелёные.

## 8. Security

1. Пароль — только `hashToken` (SHA-256), единообразно с OAuth. Не менять алгоритм.
2. `plane_api_key`/`password`/`auth_token_hash` не в pino-логах. CLI печатает
   через `output`-стрим.
3. Изоляция тенантов (workspace из токена, `auth.ts`) не затрагивается.
4. Генерация пароля — `generateOpaqueToken()` (CSPRNG), не `Math.random`.
5. `mcp_data` — секретный том (хранит хэши и plaintext Plane API-ключи, как `.env`).

## 9. Backward compatibility / ограничения

- Без новых флагов всё работает как раньше. `add-tenant` — аддитивная команда.
- **Known limitation (документировать):** смена API-ключа существующего тенанта
  на работающем сервере требует рестарта `mcp-kanban` (per-workspace
  `PlaneClient` кэшируется без TTL в `planeClientCache`). Новый тенант
  подхватывается при первом запросе. Инвалидация кэша — follow-up, вне scope.
- Число MCP-tool'ов (24) не меняется — `add-tenant` это CLI.

## 10. Документация (после кода)

- `docs/SPEC.md §6.1` / §5.1 — операторский цикл `add-tenant` → bootstrap workspace.
- `docs/CONFIGURATION.md` — раздел про `add-tenant` рядом с bootstrap.
- `docs/USER_GUIDE.md` — подраздел «Несколько тенантов (multitenant)»: UI workspace
  → API key → add-tenant → bootstrap workspace → подключение агента через OAuth;
  ограничение про рестарт.
- `docs/CHANGELOG.md` — `[Unreleased] → Added` (Keep a Changelog, без упоминания LLM).

## 11. Файлы

Новые: `add-tenant.ts`, `add-tenant.test.ts` (в `mcp-kanban/src/bootstrap/`).
Изменяемые: `server.ts`, `bootstrap/cli.ts`, `bootstrap/runner.ts`, `Makefile`,
`.env.example` (опц.), `docs/{SPEC,CONFIGURATION,USER_GUIDE,CHANGELOG}.md`.

---

## 12. Реализация (итог)

Ветка `feature/SLONK-18-add-tenant-multitenant`, worktree `../slonik-SLONK-18`.

**Новые файлы:**
- `mcp-kanban/src/bootstrap/add-tenant.ts` — CLI `add-tenant` (parseArgs,
  zod-валидация, генерация/хэш пароля, идемпотентная запись тенанта, summary
  без утечки секретов; DI-хуки `store`/`now` для тестов).
- `mcp-kanban/src/bootstrap/add-tenant.test.ts` — 11 unit-тестов.
- `mcp-kanban/src/bootstrap/cli.test.ts` — 8 тестов на `parseBootstrapArgs`
  (включая отказ на traversal-slug и пустые значения).
- `mcp-kanban/src/oauth/defaults.ts` — общий источник `OAUTH_STORE_DEFAULT_PATH`,
  `DEFAULT_OAUTH_MAX_CLIENTS`, `WORKSPACE_SLUG_RE`, `isValidWorkspaceSlug`
  (устранил дублирование констант между server.ts и CLI).

**Изменённые:**
- `mcp-kanban/src/server.ts` — dispatch-ветки `add-tenant` (с обработкой
  `--help` → exit 0) и `bootstrap` (проброс argv); импорт/re-export
  `OAUTH_STORE_DEFAULT_PATH` из `oauth/defaults`.
- `mcp-kanban/src/bootstrap/cli.ts` — `BootstrapCliOptions.workspaceSlug` /
  `planeApiKey` / `argv`; `parseBootstrapArgs` (export, валидация slug +
  непустых значений); override PlaneClient ключом тенанта.
- `mcp-kanban/src/bootstrap/runner.ts` — `RunnerDeps.workspaceSlugOverride`,
  проброс `workspaceSlug` во все обращения к Plane (workspace/project/states/
  labels/members/invite/report).
- `Makefile` — цели `add-tenant` (контейнерная) и `bootstrap ARGS=...`; `.PHONY`.
- `docs/{SPEC §6.1, CONFIGURATION §2.6/§4, USER_GUIDE §2.4, CHANGELOG}.md`.

**Проверки:** `pnpm typecheck`, `pnpm lint`, `pnpm test` (350 passed) — зелёные.
End-to-end через `tsx`: register→update идемпотентно, генерация пароля один
раз, ключ/пароль не эхо-ятся, plaintext пароль не оседает в БД (только хэш),
`--help` → exit 0, traversal/невалидный slug отклоняются.

**Ревью:**
- `security-auditor`: критичных нет. Устранён MEDIUM (валидация `--workspace`
  в bootstrap против path-traversal/SSRF). INFO про дубль `constantTimeEqual`
  в `auth.ts` и deprecation `MCP_ALLOWED_PROJECTS` — pre-existing, вне scope.
- `code-reviewer`: blocker'ов нет. Применены MAJOR (exit-код `--help`, дубль
  константы пути, потеря `closeErr`), MINOR (единый `loadConfig`, regex slug
  с запретом ведущего/завершающего дефиса, комментарий `created_at_ms`,
  пустые значения в `parseBootstrapArgs`), NIT (комментарий диспетчера,
  Makefile TTY-примечание). Вынос `writeLine`/`formatZodError` в общий модуль
  оставлен на момент появления третьего CLI (осознанно).

**Известное ограничение:** смена API-ключа уже работающего тенанта требует
рестарта `mcp-kanban` (per-workspace PlaneClient кэшируется без TTL).
Инвалидация кэша — follow-up. Автоподхват `tenant.plane_api_key` для
`bootstrap --workspace` без `--plane-api-key` — follow-up (сейчас флаг/ENV).
