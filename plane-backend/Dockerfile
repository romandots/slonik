# slonk — пропатченный Plane backend (SLONK-32).
#
# Тонкая надстройка над upstream-образом: тот же код, те же entrypoint'ы,
# сверху накатывается патч `patches/0001_s3storage_is_server.py`, который
# чинит `S3Storage` — без него весь публичный token-API ассетов Plane
# отвечает 500 (подробности — в шапке самого патча и в docs/DEPLOY.md).
#
# Версия upstream приходит build-аргументом и должна совпадать с
# `PLANE_IMAGE_TAG` из `.env`: фронтенды остаются на upstream-образах, и
# расхождение backend/frontend по версии недопустимо. Тег собранного
# образа — `<upstream>-slonk<N>`, где N растёт при изменении набора
# патчей (см. `PLANE_BACKEND_TAG` в docs/CONFIGURATION.md).
#
# Пользователя базовый образ не задаёт (upstream Dockerfile.api — от root,
# WORKDIR /code), поэтому USER здесь тоже не трогаем.

ARG PLANE_IMAGE_TAG=v1.3.0
FROM makeplane/plane-backend:${PLANE_IMAGE_TAG}

COPY patches/ /tmp/slonk-patches/

# Путь к storage.py ищем, а не хардкодим: layout внутри upstream-образа —
# их внутреннее дело и между релизами меняется. Если файл не найден или
# найден не в единственном экземпляре — падаем, чтобы не выпустить
# непропатченный образ молча. По той же причине после патча проверяем
# и синтаксис, и то, что новая сигнатура на месте, а старой не осталось.
RUN set -eu; \
    matches="$(find /code /usr/local/lib -type f -path '*/plane/settings/storage.py' 2>/dev/null)"; \
    count="$(printf '%s\n' "$matches" | grep -c . || true)"; \
    if [ "$count" != "1" ]; then \
        echo "ОШИБКА: ожидался ровно один plane/settings/storage.py, найдено $count:" >&2; \
        printf '%s\n' "$matches" >&2; \
        exit 1; \
    fi; \
    python3 /tmp/slonk-patches/0001_s3storage_is_server.py "$matches"; \
    python3 -m py_compile "$matches"; \
    grep -q 'def __init__(self, request=None, is_server=False):' "$matches"; \
    if grep -q 'def __init__(self, request=None):' "$matches"; then \
        echo "ОШИБКА: непропатченная сигнатура осталась в $matches" >&2; \
        exit 1; \
    fi; \
    rm -rf /tmp/slonk-patches "$(dirname "$matches")/__pycache__"; \
    echo "slonk-патч применён: $matches"
