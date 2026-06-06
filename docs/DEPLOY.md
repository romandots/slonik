# DEPLOY.md — деплой и автодеплой slonk

Канонический документ по выкладке slonk на прод-хост: ручной деплой,
CI/CD-пайплайн на GitHub Actions, подготовка сервера, секреты, rollback и
типовые проблемы. Конфиг `.env`/compose-overlay'ев — в
[CONFIGURATION.md](./CONFIGURATION.md); этот файл описывает только то, что
касается выкладки.

> Workflow-файлы — источник правды по шагам пайплайна:
> [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) и
> [`.github/workflows/release-deploy.yml`](../.github/workflows/release-deploy.yml).
> При правке пайплайна обновляй и этот документ.

---

## 1. Модель деплоя

slonk — self-hosted, single-node. Прод — один хост с Docker, на котором лежит
рабочая копия репозитория (compose-файлы, `Makefile`, `.env` с прод-секретами) в
`DEPLOY_DIR` (в этом инстансе — `/home/romandots/slonik`). Деплоится **только** образ
`mcp-kanban` (и при включённом overlay — `backup`); образы Plane тянутся с
upstream по pinned-тегам и не пересобираются.

Два способа выкатки:

| Способ | Когда |
|---|---|
| **Автодеплой** (CI/CD) | штатный путь: push в `main` → сборка → SSH-деплой. См. §3. |
| **Ручной деплой** | первичная установка, отладка, hotfix без CI. См. §6. |

---

## 2. Архитектура пайплайна

```
PR в main/develop ──► ci.yml ──► lint │ build │ test   (3 параллельных джобы, блокируют merge)

push в main ──► release-deploy.yml:
   gate (lint + typecheck + build + test)
        │
        ▼
   release (build & push образов в GHCR: :VERSION + :latest)
        │
        ▼
   deploy (SSH на прод: pull → compose up --wait → health-gate → rollback при провале)
        │
        ▼
   smoke (make smoke-mcp на проде)
```

Версия образа берётся из `mcp-kanban/package.json` → поле `version`.
`concurrency: deploy-prod` с `cancel-in-progress: false` — два деплоя
никогда не идут параллельно, запущенный не отменяется.

---

## 3. Автодеплой: что происходит на push в `main`

Файл: [`.github/workflows/release-deploy.yml`](../.github/workflows/release-deploy.yml).

### 3.1 `gate` — предохранитель перед публикацией

Повторяет CI на финальном коммите `main`: `pnpm install --frozen-lockfile` →
`pnpm lint` → `pnpm typecheck` → `pnpm build` → `pnpm test`. Если красный —
ни сборки образов, ни деплоя не будет.

### 3.2 `release` — сборка и публикация в GHCR

- Читает версию из `mcp-kanban/package.json`.
- Логинится в GHCR автоматическим `GITHUB_TOKEN` (права `packages: write`).
- Собирает и пушит два образа с тегами `:VERSION` и `:latest`:
  - `ghcr.io/romandots/slonk/mcp-kanban`
  - `ghcr.io/romandots/slonk/backup`
- Кэш слоёв — GitHub Actions cache (`type=gha`).

### 3.3 `deploy` — выкладка на прод по SSH

Джоба привязана к GitHub Environment **`production`** (`environment: production`)
— здесь можно повесить required reviewers и environment-scoped секреты (§5).

По SSH (`appleboy/ssh-action`) на `DEPLOY_DIR` (`/home/romandots/slonik`):

1. `docker login ghcr.io` через `GHCR_PULL_TOKEN` (`--password-stdin`).
2. Запоминает текущий `SLONK_MCP_IMAGE_TAG` из `.env` — для rollback.
3. `docker pull ghcr.io/.../mcp-kanban:VERSION` + ретег в `slonk/mcp-kanban:VERSION`.
4. `SLONK_MCP_IMAGE_TAG=VERSION docker compose up -d mcp-kanban --wait`:
   - `--wait` ждёт, пока контейнер не станет `healthy` (health-gate).
   - **успех** → записывает `SLONK_MCP_IMAGE_TAG=VERSION` в `.env`, чтобы
     ручные рестарты тоже поднимали новую версию;
   - **провал** → откат на предыдущий тег (`SLONK_MCP_IMAGE_TAG=PREV docker
     compose up -d mcp-kanban`) и `exit 1`.

### 3.4 `smoke` — пост-деплой проверка

После успешного деплоя — `make smoke-mcp` на проде: статус контейнера
`mcp-kanban` + `GET http://localhost:${MCP_HOST_PORT:-8787}/health`. Проверяется
именно то, что деплоится (опубликованный порт MCP), без завязки на топологию
Plane/прокси. Падение smoke помечает workflow красным (но контейнер уже поднят).
Цель `make smoke` (проверка Plane UI на `localhost:${PLANE_HOST_PORT:-3000}`)
остаётся для локальной/dev-проверки, где порт Plane опубликован на хост.

---

## 4. CI на PR — `ci.yml`

Файл: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). Запускается на
каждый PR в `main` или `develop`, три параллельных джобы:

| Джоба | Шаги |
|---|---|
| `lint` (Lint & Typecheck) | `pnpm lint` + `pnpm typecheck` |
| `build` (Build) | `pnpm build` (tsc) + `docker build` smoke без push |
| `test` (Test) | `pnpm test` (vitest) |

Node 22 LTS из `mcp-kanban/.nvmrc`; pnpm-store кэшируется через
`cache: pnpm` в `actions/setup-node`. `concurrency` отменяет устаревшие прогоны
по тому же ref. Красный чек блокирует merge при включённом branch protection (§8).

---

## 5. GitHub Secrets и Environment

### 5.1 Secrets

Settings → Secrets and variables → Actions:

| Secret | Описание |
|---|---|
| `SSH_HOST` | IP / hostname прод-хоста |
| `SSH_USER` | пользователь SSH (в группе `docker`, **не** root) |
| `SSH_PRIVATE_KEY` | приватный SSH-ключ деплоя (отдельная пара, см. §7.2) |
| `GHCR_PULL_TOKEN` | PAT (classic) с `read:packages` — для `docker login` на проде при pull приватных образов |

Push в GHCR из workflow секрета не требует — используется автоматический
`GITHUB_TOKEN` с `packages: write`.

### 5.2 Environment `production`

Deploy-джоба объявлена с `environment: production`. Создай environment:
Settings → Environments → New environment → `production`. Что полезно настроить:

- **Required reviewers** — деплой будет ждать ручного approve перед выкладкой.
- **Deployment branches** — ограничить запуск только веткой `main`.
- Перенести `SSH_*` / `GHCR_PULL_TOKEN` на уровень environment (а не репозитория)
  — тогда они доступны только в `production`-джобе.

Без созданного environment джоба отработает, но required-reviewers/защиты,
рассчитанные на него, применяться не будут.

---

## 6. Ручной деплой

На случай первичной установки или hotfix без CI — из `DEPLOY_DIR` на проде:

```bash
cd /home/romandots/slonik

# залогиниться в GHCR (один раз, см. §7.3)
echo "$GHCR_PULL_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin

# подтянуть нужную версию и поднять с health-gate
VERSION=1.2.3
docker pull ghcr.io/romandots/slonk/mcp-kanban:$VERSION
docker tag  ghcr.io/romandots/slonk/mcp-kanban:$VERSION slonk/mcp-kanban:$VERSION

SLONK_MCP_IMAGE_TAG=$VERSION docker compose up -d mcp-kanban --wait

# зафиксировать тег для будущих рестартов
sed -i "s/^SLONK_MCP_IMAGE_TAG=.*/SLONK_MCP_IMAGE_TAG=$VERSION/" .env  # или дописать строку

make smoke
```

Локальная сборка образа без GHCR — `make build` (см.
[CONFIGURATION.md](./CONFIGURATION.md) и корневой `Makefile`).

---

## 7. Подготовка прод-хоста (первичная)

### 7.1 Каталог и рабочая копия

```bash
# каталог деплоя = рабочая копия репозитория на проде
cd /home/romandots/slonik
# должны присутствовать: docker-compose.yml (+ нужные overlay), Makefile,
# .env (прод-секреты, все change_me заменены)
docker compose version   # требуется compose v2
make --version
```

> Для каталога в `$HOME` `sudo`/`mkdir`/`chown` не нужны — он уже принадлежит
> `SSH_USER`. Если разворачиваешь в системный путь (например `/opt/slonk`),
> создай каталог и отдай его пользователю деплоя: `sudo mkdir -p <dir> &&
> sudo chown "$USER":"$USER" <dir>`.

`.env` должен быть писабельным для `SSH_USER`: deploy-скрипт делает по нему
`sed -i` для фиксации `SLONK_MCP_IMAGE_TAG`.

### 7.2 SSH deploy key

```bash
# на своей машине — отдельная пара ключей под деплой
ssh-keygen -t ed25519 -f slonk_deploy -C "github-actions-deploy" -N ""
ssh-copy-id -i slonk_deploy.pub <ssh-user>@<prod-host>   # публичный → на прод
# приватный slonk_deploy → secret SSH_PRIVATE_KEY
```

### 7.3 Первичный логин в GHCR

```bash
echo "<GHCR_PULL_TOKEN>" | docker login ghcr.io -u <github-user> --password-stdin
```

### 7.4 Свой registry-namespace

Если GitHub-аккаунт/орг ≠ `romandots`, поправь `env` в
[`release-deploy.yml`](../.github/workflows/release-deploy.yml):

```yaml
env:
  IMAGE_MCP: ghcr.io/<твой-аккаунт>/slonk/mcp-kanban
  IMAGE_BACKUP: ghcr.io/<твой-аккаунт>/slonk/backup
```

`DEPLOY_DIR` задаётся в env deploy-джобы (`/home/romandots/slonik`) и
дублируется в шаге `Post-deploy smoke` — при смене каталога поправь оба места.

---

## 8. Branch protection

Settings → Branches → правило на `main`:

- **Require status checks to pass before merging** → выбрать `lint`, `build`, `test`.
- **Require a pull request before merging** — прямой push в `main` запрещён.

Тогда в `main` попадает только зелёный код, а сам push в `main` (после
squash-merge PR) запускает автодеплой.

---

## 9. Версионирование релизов

Тег образа = `version` из `mcp-kanban/package.json`. Бамп версии — обязанность
`merger-agent` в рамках стадии `Merging`: правка `package.json` + запись в
`docs/CHANGELOG.md` ([Keep a Changelog](https://keepachangelog.com)) + git-тег
`vX.Y.Z` (SemVer). Если версию не поднять, новый образ перезапишет тег `:VERSION`
тем же значением — деплой пройдёт, но история версий в GHCR смажется.

---

## 10. Rollback

Автоматический откат встроен в deploy-джобу: при провале `--wait`-health-gate
скрипт поднимает предыдущий `SLONK_MCP_IMAGE_TAG`. Ручной откат:

```bash
cd /home/romandots/slonik
SLONK_MCP_IMAGE_TAG=<предыдущая-версия> docker compose up -d mcp-kanban --wait
sed -i "s/^SLONK_MCP_IMAGE_TAG=.*/SLONK_MCP_IMAGE_TAG=<предыдущая-версия>/" .env
make smoke
```

Образы предыдущих версий доступны в GHCR по тегу `:VERSION` (пока не вычищены
retention-политикой пакета).

---

## 11. Troubleshooting

| Симптом | Причина / что проверить |
|---|---|
| `deploy` падает на `docker login` | истёк/неверный `GHCR_PULL_TOKEN`, нет `read:packages`, образ приватный и не расшарен на аккаунт |
| `--wait` зависает и откатывается | контейнер не становится `healthy`: смотри `docker compose logs mcp-kanban`, healthcheck MCP, `.env` (PLANE_API_KEY и пр.) |
| SSH-джоба: permission denied | `SSH_PRIVATE_KEY` не соответствует `authorized_keys`, `SSH_USER` не в группе `docker` |
| `sed: .env: Permission denied` | `.env` не писабелен для `SSH_USER` — поправь владельца/права |
| деплой не стартует на push | push не в `main`, либо required reviewers в `production` ждут approve |
| образ собрался, но прод на старой версии | `SLONK_MCP_IMAGE_TAG` в `.env` не обновился (провал health-gate → откат) — смотри лог деплоя |
| smoke красный, контейнер живой | MCP ещё прогревается — проверь `docker compose ps mcp-kanban`, повтори `make smoke-mcp`; для Plane UI на проде помни, что порт не опубликован (см. §3.4) |

---

## См. также

- [CONFIGURATION.md](./CONFIGURATION.md) — `.env`, compose-overlay'и, лимиты, версии образов.
- [ARCHITECTURE.md](./ARCHITECTURE.md) — сети, контейнеры, модель угроз.
- [CONVENTIONS.md](./CONVENTIONS.md) — git-workflow, версионирование, CHANGELOG.
