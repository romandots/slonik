# SLONK-19 — Поле «Workspace» в форме OAuth-логина (выбор тенанта без смены URL)

## Проблема
Remote-коннектор claude.ai не передаёт `?workspace=` в `/oauth/authorize` (строит
URL из OAuth-метаданных, query-хвост коннектор-адреса отбрасывает). Поэтому
`q.workspace` всегда `undefined` → `targetWorkspace = defaultWorkspace` → форма
логина авторизует только дефолтный workspace `agents` (пароль = `MCP_AUTH_TOKEN`).
Не-дефолтного тенанта через claude.ai выбрать нельзя.

## Решение (без смены URL коннектора)
Форму `/oauth/authorize` рендерит сам сервер (`oauth/routes.ts:renderLoginForm`).
Сделать поле **Workspace редактируемым** (сейчас оно скрытое и приходит пустым):
оператор вводит workspace + пароль, POST несёт workspace в теле, сервер выбирает
тенанта и сверяет его пароль. URL коннектора остаётся `…/mcp`.

## Изменения (`mcp-kanban/src/oauth/routes.ts`)
1. `renderLoginForm(q, defaultWorkspace, errorMsg?)` — вместо скрытого/условного
   поля workspace показывать `<input type="text" name="workspace" required
   value="${q.workspace ?? defaultWorkspace}">`. Значение из POST сохраняется при
   повторном рендере (ошибка пароля/неизвестный workspace).
2. GET `/oauth/authorize` → `renderLoginForm(q, deps.defaultWorkspace)`.
3. POST `/oauth/authorize`:
   - `targetWorkspace = q.workspace ?? deps.defaultWorkspace`.
   - **Валидация:** если `getTenantByWorkspace(targetWorkspace) === undefined` И
     `targetWorkspace !== deps.defaultWorkspace` → ре-рендер формы с ошибкой
     «Unknown workspace …» (status 400). Закрывает footgun: ввод произвольного
     workspace + `MCP_AUTH_TOKEN` не должен авторизовать к несуществующему ws.
   - Логика пароля без изменений (tenant.hash, иначе fallback `MCP_AUTH_TOKEN`
     только для дефолтного workspace).
   - При неверном пароле — `renderLoginForm(q, deps.defaultWorkspace, 'Invalid password')`.

## Инвариант безопасности
Workspace по-прежнему зашивается в токен (claim `workspace`) и проверяется на
`/mcp`. Поле формы лишь задаёт, какого тенанта авторизуем; пароль сверяется
с хэшем именно этого тенанта. `resource`/audience (`…/mcp`) не меняется.

## Тесты (`routes.test.ts`)
- GET form содержит редактируемый `input name="workspace"` с дефолтом.
- POST workspace=<tenant> + верный пароль тенанта → 302, code сохранён с
  `workspace=<tenant>`; токен по нему привязан к тенанту.
- POST workspace=<tenant> + неверный пароль → 401, ре-рендер.
- POST unknown workspace → 400 «Unknown workspace».
- POST дефолтный workspace + `MCP_AUTH_TOKEN` → 302 (backward compat).

## Вне scope
Path-вариант `/{workspace}` (отклонён). Авто-подхват workspace из коннектора
(claude.ai не пробрасывает).
