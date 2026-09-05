#!/usr/bin/env python3
"""Патч upstream-бага Plane: S3Storage не принимает `is_server` (SLONK-32).

Проблема
--------
В `plane/api/views/asset.py` (публичный token-API, тот, которым ходит
`mcp-kanban`) storage создаётся как::

    storage = S3Storage(request=request, is_server=True)

а сигнатура в `plane/settings/storage.py` — только `def __init__(self,
request=None)`. Любой вызов падает `TypeError`, generic-обработчик
`BaseAPIView` превращает его в `HTTP 500 {"error": "Something went wrong
please try again later"}`. Ломаются `GenericAssetEndpoint.post` и
`.get` — то есть весь публичный API ассетов, на котором держится
`embed_image`. Эндпоинты, которыми пользуется Plane UI
(`plane/app/views/asset/v2.py`), зовут `S3Storage(request=request)` и
поэтому работают — баг виден только через API-ключ.

Проверено на upstream-ветках `master` и `preview`: там та же сигнатура и
те же вызовы, то есть апгрейд Plane проблему не решает.

Что делает патч
---------------
Добавляет параметр и реализует его смысл: `is_server=True` означает
«presigned URL получит сервер, а не браузер», поэтому endpoint берётся
внутренний (`AWS_S3_ENDPOINT_URL` / `MINIO_ENDPOINT_URL`), а не хост
входящего HTTP-запроса. В теле `__init__` для этого достаточно погасить
`request`: обе ветки (MinIO и обычный S3) в этом случае уже используют
`self.aws_s3_endpoint_url`.

Скрипт идемпотентен: повторный запуск на пропатченном файле — no-op.
Если upstream изменит сигнатуру (в том числе если починит баг сам), скрипт
завершится с ошибкой и уронит сборку образа — это осознанно: патч
должен быть пересмотрен, а не применён вслепую.
"""

from __future__ import annotations

import pathlib
import sys

ANCHOR = "    def __init__(self, request=None):\n"

REPLACEMENT = """    def __init__(self, request=None, is_server=False):
        # slonk-патч (SLONK-32): upstream зовёт S3Storage(..., is_server=True)
        # в plane/api/views/asset.py, но параметра в сигнатуре нет — TypeError
        # превращается в HTTP 500 на всём публичном API ассетов.
        # Семантика параметра: presigned URL предназначен серверу, а не
        # браузеру, поэтому endpoint берём внутренний, а не хост запроса.
        if is_server:
            request = None
"""

PATCHED_MARKER = "def __init__(self, request=None, is_server=False):"


def patch(path: pathlib.Path) -> bool:
    """Патчит файл. Возвращает True, если файл изменён, False — если уже патчен."""
    source = path.read_text(encoding="utf-8")

    if PATCHED_MARKER in source:
        return False

    occurrences = source.count(ANCHOR)
    if occurrences != 1:
        raise SystemExit(
            f"{path}: ожидалась ровно одна строка `{ANCHOR.strip()}`, найдено {occurrences}. "
            "Upstream изменил S3Storage — патч нужно пересмотреть, а не применять вслепую."
        )

    path.write_text(source.replace(ANCHOR, REPLACEMENT, 1), encoding="utf-8")
    return True


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {argv[0]} <path/to/plane/settings/storage.py>", file=sys.stderr)
        return 2

    path = pathlib.Path(argv[1])
    if not path.is_file():
        raise SystemExit(f"{path}: файл не найден")

    changed = patch(path)
    print(f"{path}: {'патч применён' if changed else 'патч уже был применён'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
