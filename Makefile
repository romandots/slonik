# slonk — Makefile
#
# Цели жизненного цикла стека. Подробности реализации — в docs/.
# Фазы по ROADMAP.md:
#   Phase 1 (реализовано): up, down, logs, smoke
#   Phase 2 (планируется): test, build
#   Phase 3 (планируется): bootstrap

.DEFAULT_GOAL := help

# Compose-команды: базовый файл + (опц.) dev/proxy-overlay через make dev=1 / proxy=1.
# dev и proxy несовместимы в проде, но Makefile позволяет включить оба для отладки.
COMPOSE := docker compose
COMPOSE_FILES := -f docker-compose.yml
ifeq ($(dev),1)
	COMPOSE_FILES += -f docker-compose.dev.yml
endif
ifeq ($(proxy),1)
	COMPOSE_FILES += -f docker-compose.proxy.yml
endif
ifeq ($(obs),1)
	COMPOSE_FILES += -f docker-compose.obs.yml
endif
ifeq ($(backup),1)
	COMPOSE_FILES += -f docker-compose.backup.yml
endif

.PHONY: help up up-dev up-proxy up-obs up-backup backup-now down down-v logs ps smoke smoke-roles test build release bootstrap add-role config pull

help: ## Показать доступные цели
	@awk 'BEGIN { FS = ":.*##"; printf "Доступные цели:\n" } \
		/^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2 }' \
		$(MAKEFILE_LIST)
	@echo
	@echo "Флаги:"
	@echo "  dev=1        включить docker-compose.dev.yml overlay (публикация портов БД/MinIO/API на хост)"
	@echo "  proxy=1      включить docker-compose.proxy.yml overlay (внешний Caddy TLS-шлюз)"
	@echo "  obs=1        включить docker-compose.obs.yml overlay (Prometheus/Grafana/Loki/Promtail)"
	@echo "  backup=1     включить docker-compose.backup.yml overlay (cron-bound бэкап-сервис)"

up: ## Поднять стек в фоне (use dev=1 / proxy=1 для overlay'ев)
	$(COMPOSE) $(COMPOSE_FILES) up -d --wait
	@echo
ifneq ($(proxy),1)
	@echo "Plane UI: http://localhost:$${PLANE_HOST_PORT:-3000}/"
	@echo "Первый запуск: откройте $${PLANE_DOMAIN:-http://localhost:3000}/god-mode для создания admin'а."
else
	@echo "Plane UI: https://$${CADDY_DOMAIN:-plane.localhost}/"
	@echo "MCP:      https://$${CADDY_MCP_DOMAIN:-mcp.localhost}/"
	@echo "Self-signed CA: примите Caddy internal root, либо настройте Let's Encrypt (CADDY_TLS_MODE=<email>)."
endif

up-dev: ## Поднять стек с dev-overlay (публикуется postgres/redis/rabbitmq/minio/api)
	$(MAKE) up dev=1

up-proxy: ## Поднять стек с proxy-overlay (внешний Caddy + HTTPS, базовые порты скрыты)
	$(MAKE) up proxy=1

up-obs: ## Поднять стек с observability-overlay (Prometheus/Grafana/Loki/Promtail)
	$(MAKE) up obs=1
	@echo
	@echo "Grafana:    http://localhost:$${GRAFANA_HOST_PORT:-3001}/ (login: $${GRAFANA_ADMIN_USER:-admin})"
	@echo "Prometheus: http://localhost:$${PROMETHEUS_HOST_PORT:-9090}/"

up-backup: ## Поднять стек с backup-overlay (cron-bound pg_dump + minio mirror + mcp_data tar)
	$(MAKE) up backup=1
	@echo
	@echo "Бэкап выполняется по расписанию $${BACKUP_CRON:-0 3 * * *} (UTC)."
	@echo "Разовый запуск: make backup-now"

backup-now: ## Разовый запуск бэкапа (требует backup=1 overlay)
	$(COMPOSE) -f docker-compose.yml -f docker-compose.backup.yml run --rm backup run-once

down: ## Остановить стек, сохранив volume'ы
	$(COMPOSE) $(COMPOSE_FILES) down

down-v: ## Остановить стек и УДАЛИТЬ volume'ы (потеря всех данных!)
	@printf "ВНИМАНИЕ: это удалит ВСЕ данные Plane. Введите 'yes' для подтверждения: "; \
	read confirm; \
	[ "$$confirm" = "yes" ] && $(COMPOSE) $(COMPOSE_FILES) down -v || echo "Отменено."

logs: ## Тейлить логи всех сервисов (Ctrl-C — выйти)
	$(COMPOSE) $(COMPOSE_FILES) logs -f --tail=100

ps: ## Показать статус контейнеров
	$(COMPOSE) $(COMPOSE_FILES) ps

smoke: ## Проверка работоспособности: статус сервисов + Plane UI
	@echo "[1/2] Статус контейнеров:"
	@$(COMPOSE) $(COMPOSE_FILES) ps
	@echo
	@echo "[2/2] Plane UI smoke check (http://localhost:$${PLANE_HOST_PORT:-3000}/)..."
	@curl --fail --silent --max-time 5 \
		"http://localhost:$${PLANE_HOST_PORT:-3000}/" >/dev/null \
		&& echo "✓ Plane UI отвечает" \
		|| (echo "✗ Plane UI недоступен" && exit 1)

config: ## Вывести merged compose-конфиг (полезно для отладки)
	$(COMPOSE) $(COMPOSE_FILES) config

pull: ## Обновить все pinned-образы из реестра
	$(COMPOSE) $(COMPOSE_FILES) pull

test: ## Запустить unit-тесты MCP-сервера
	cd mcp-kanban && pnpm install --frozen-lockfile --ignore-scripts && pnpm test

build: ## Собрать Docker-образ mcp-kanban
	$(COMPOSE) $(COMPOSE_FILES) build mcp-kanban

# slonk-релиз: версии берутся из переменной SLONK_VERSION (default 1.0.0).
# Собирает оба собственных образа (mcp-kanban + backup) и тегирует их
# `slonk/<svc>:${SLONK_VERSION}` + `slonk/<svc>:latest`. Подпись cosign'ом
# — опц., через SLONK_RELEASE_SIGN=1 (требует cosign в PATH).
SLONK_VERSION ?= 1.0.0
release: ## Собрать релизные образы slonk/mcp-kanban + slonk/backup на SLONK_VERSION
	@echo "[release] building slonk/mcp-kanban:$(SLONK_VERSION)"
	docker build -t slonk/mcp-kanban:$(SLONK_VERSION) -t slonk/mcp-kanban:latest ./mcp-kanban
	@echo "[release] building slonk/backup:$(SLONK_VERSION)"
	docker build -t slonk/backup:$(SLONK_VERSION) -t slonk/backup:latest ./backup
ifneq ($(SLONK_RELEASE_SIGN),)
	@echo "[release] cosign sign"
	cosign sign --yes slonk/mcp-kanban:$(SLONK_VERSION)
	cosign sign --yes slonk/backup:$(SLONK_VERSION)
endif
	@echo
	@echo "Done. Образы:"
	@docker images --format 'table {{.Repository}}:{{.Tag}}\t{{.Size}}' \
		| grep -E '^slonk/(mcp-kanban|backup):' || true

bootstrap: ## Идемпотентная инициализация Plane (workspace/project/states/labels/identities)
	$(COMPOSE) $(COMPOSE_FILES) run --rm mcp-kanban node dist/server.js bootstrap

# SLONK-12: интерактивное создание новой роли в mcp-kanban/roles/.
# Запускается ЛОКАЛЬНО (не в контейнере), чтобы был TTY для prompt'ов и
# чтобы файл сразу появился в репозиторской директории `mcp-kanban/roles/`.
# Принимает позиционные аргументы как обычная CLI: `make add-role -- --role X ...`.
ARGS ?=
add-role: ## SLONK-12: интерактивно добавить новую роль в mcp-kanban/roles/
	cd mcp-kanban && pnpm tsx src/server.ts add-role $(ARGS)

smoke-roles: ## SLONK-6: smoke claim_issue по всем ролям против ЖИВОГО Plane
	cd mcp-kanban && pnpm tsx scripts/smoke-roles-claim.ts
