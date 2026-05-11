#!/bin/bash
# slonk — backup runner.
# Делает три вещи последовательно (любая может упасть — fail-fast):
#   1) pg_dump (custom format, gzip-сжатый);
#   2) mc mirror MinIO bucket'ов в /backups/minio/$BUCKET/;
#   3) tar -czf /mcp_data (SQLite + логи).
# Опционально (если задан BACKUP_S3_ENDPOINT) — пушит всё в внешний S3.
# В конце прибирает локальные файлы старше $BACKUP_RETENTION_DAYS.

set -euo pipefail

TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
OUT_DIR="/backups"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

log() {
  printf '{"ts":"%s","level":"info","msg":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}
fail() {
  printf '{"ts":"%s","level":"error","msg":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
  exit 1
}

log "backup start $TIMESTAMP"

mkdir -p "$OUT_DIR/minio"

# -----------------------------------------------------------------------------
# 1) Postgres (Plane)
# -----------------------------------------------------------------------------
: "${POSTGRES_HOST:?POSTGRES_HOST is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"

PG_DUMP="$OUT_DIR/postgres-$TIMESTAMP.dump.gz"
log "pg_dump → $PG_DUMP"
PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
  --host="$POSTGRES_HOST" \
  --port="${POSTGRES_PORT:-5432}" \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_DB" \
  --format=custom \
  --no-owner --no-acl \
  | gzip -9 > "$PG_DUMP"
PG_SIZE=$(stat -c%s "$PG_DUMP" 2>/dev/null || wc -c <"$PG_DUMP")
log "pg_dump done bytes=$PG_SIZE"

# -----------------------------------------------------------------------------
# 2) MinIO buckets
# -----------------------------------------------------------------------------
: "${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"
mc alias set src "http://minio:9000" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null

for bucket in "${MINIO_BUCKET_PLANE:-plane-uploads}" "${MINIO_BUCKET_MCP:-mcp-artifacts}"; do
  log "mc mirror src/$bucket → $OUT_DIR/minio/$bucket/"
  mkdir -p "$OUT_DIR/minio/$bucket"
  mc mirror --overwrite --remove --quiet "src/$bucket" "$OUT_DIR/minio/$bucket/" \
    || fail "mc mirror $bucket failed"
done

# -----------------------------------------------------------------------------
# 3) mcp_data (SQLite identity/audit/git_refs + optional logs)
# -----------------------------------------------------------------------------
MCP_TARBALL="$OUT_DIR/mcp_data-$TIMESTAMP.tar.gz"
log "tar mcp_data → $MCP_TARBALL"
if [ -d /mcp_data ]; then
  tar --create --gzip --file="$MCP_TARBALL" --directory=/mcp_data .
else
  log "/mcp_data is missing — skipping mcp_data tarball"
fi

# -----------------------------------------------------------------------------
# 4) Optional: external S3 push
# -----------------------------------------------------------------------------
if [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then
  : "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required when BACKUP_S3_ENDPOINT is set}"
  : "${BACKUP_S3_ACCESS_KEY:?BACKUP_S3_ACCESS_KEY is required when BACKUP_S3_ENDPOINT is set}"
  : "${BACKUP_S3_SECRET_KEY:?BACKUP_S3_SECRET_KEY is required when BACKUP_S3_ENDPOINT is set}"
  log "mc external upload → $BACKUP_S3_ENDPOINT/$BACKUP_S3_BUCKET/$TIMESTAMP/"
  mc alias set dst "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_ACCESS_KEY" "$BACKUP_S3_SECRET_KEY" >/dev/null
  mc mb --ignore-existing "dst/$BACKUP_S3_BUCKET" >/dev/null || true
  mc cp --quiet "$PG_DUMP" "dst/$BACKUP_S3_BUCKET/$TIMESTAMP/" || fail "external pg upload failed"
  if [ -f "$MCP_TARBALL" ]; then
    mc cp --quiet "$MCP_TARBALL" "dst/$BACKUP_S3_BUCKET/$TIMESTAMP/" || fail "external mcp_data upload failed"
  fi
  mc mirror --quiet "$OUT_DIR/minio/" "dst/$BACKUP_S3_BUCKET/$TIMESTAMP/minio/" || fail "external minio upload failed"
fi

# -----------------------------------------------------------------------------
# 5) Retention prune (local copies)
# -----------------------------------------------------------------------------
log "retention prune (>${RETENTION_DAYS}d local copies)"
find "$OUT_DIR" -maxdepth 1 -type f \
  \( -name 'postgres-*.dump.gz' -o -name 'mcp_data-*.tar.gz' \) \
  -mtime "+${RETENTION_DAYS}" -delete

log "backup OK $TIMESTAMP"
