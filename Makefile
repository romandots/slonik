# slonk — Makefile
#
# Цели жизненного цикла стека. Подробности реализации — в plane/docs/.
# Фазы по ROADMAP.md:
#   Phase 1 (реализовано): up, down, logs, smoke
#   Phase 2 (планируется): test, build
#   Phase 3 (планируется): bootstrap

.DEFAULT_GOAL := help

# Compose-команды: базовый файл + (опц.) dev-overlay через make dev=1.
COMPOSE := docker compose
COMPOSE_FILES := -f docker-compose.yml
ifeq ($(dev),1)
	COMPOSE_FILES += -f docker-compose.dev.yml
endif

.PHONY: help up up-dev down down-v logs ps smoke test bootstrap config pull

help: ## Показать доступные цели
	@awk 'BEGIN { FS = ":.*##"; printf "Доступные цели:\n" } \
		/^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2 }' \
		$(MAKEFILE_LIST)
	@echo
	@echo "Флаги:"
	@echo "  dev=1        включить docker-compose.dev.yml overlay (публикация портов БД/MinIO/API на хост)"

up: ## Поднять стек в фоне (использует docker-compose.yml; dev=1 — с overlay)
	$(COMPOSE) $(COMPOSE_FILES) up -d --wait
	@echo
	@echo "Plane UI: http://localhost:$${PLANE_HOST_PORT:-3000}/"
	@echo "Первый запуск: откройте $${PLANE_DOMAIN:-http://localhost:3000}/god-mode для создания admin'а."

up-dev: ## Поднять стек с dev-overlay (публикуется postgres/redis/rabbitmq/minio/api)
	$(MAKE) up dev=1

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

test: ## Запустить тесты MCP-сервера (реализуется в Phase 2)
	@echo "make test: цель будет реализована в Phase 2 (см. plane/docs/ROADMAP.md)"
	@exit 1

bootstrap: ## Идемпотентная инициализация Plane (реализуется в Phase 3)
	@echo "make bootstrap: цель будет реализована в Phase 3 (см. plane/docs/ROADMAP.md)"
	@exit 1
