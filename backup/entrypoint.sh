#!/bin/bash
# slonk backup entrypoint.
#
# По умолчанию запускает supercronic с расписанием `$BACKUP_CRON`.
# Поддерживает два sub-режима для разовых запусков:
#   `run-once` — выполнить run.sh один раз и выйти (для `make backup-now`).
#   любой другой arg — exec этим аргументом (для отладки в shell).

set -euo pipefail

case "${1:-cron}" in
  run-once)
    exec /usr/local/bin/run-backup
    ;;
  cron)
    SCHED="${BACKUP_CRON:-0 3 * * *}"
    # supercronic ожидает строку формата `<cron-expr> <command>` в файле.
    echo "$SCHED /usr/local/bin/run-backup" > /etc/supercronic.crontab
    echo "[backup] starting supercronic with schedule: $SCHED" >&2
    exec /usr/local/bin/supercronic -passthrough-logs /etc/supercronic.crontab
    ;;
  *)
    exec "$@"
    ;;
esac
