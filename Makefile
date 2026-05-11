# slonk — Makefile
#
# Заглушки для основных команд жизненного цикла стека. Реализация целей
# подтягивается в последующих фазах:
#   up, down, logs   — Phase 1 (docker-compose со стеком Plane)
#   test             — Phase 2 (unit-тесты MCP-сервера)
#   bootstrap        — Phase 3 (идемпотентная инициализация Plane)
#
# `make` без аргументов печатает этот список целей.

.DEFAULT_GOAL := help

# Все цели — phony: ничего не собираем в файлы.
.PHONY: help up down logs test bootstrap

help: ## Показать доступные цели
	@awk 'BEGIN { FS = ":.*##"; printf "Доступные цели:\n" } \
		/^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2 }' \
		$(MAKEFILE_LIST)

up: ## Поднять полный стек (реализуется в Phase 1)
	@echo "make up: цель будет реализована в Phase 1 (см. plane/docs/ROADMAP.md)"
	@exit 1

down: ## Остановить стек (реализуется в Phase 1)
	@echo "make down: цель будет реализована в Phase 1 (см. plane/docs/ROADMAP.md)"
	@exit 1

logs: ## Тейлить логи сервисов (реализуется в Phase 1)
	@echo "make logs: цель будет реализована в Phase 1 (см. plane/docs/ROADMAP.md)"
	@exit 1

test: ## Запустить тесты MCP-сервера (реализуется в Phase 2)
	@echo "make test: цель будет реализована в Phase 2 (см. plane/docs/ROADMAP.md)"
	@exit 1

bootstrap: ## Идемпотентная инициализация Plane (реализуется в Phase 3)
	@echo "make bootstrap: цель будет реализована в Phase 3 (см. plane/docs/ROADMAP.md)"
	@exit 1
