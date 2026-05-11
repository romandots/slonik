# slonk — backup runner (Phase 9).
#
# Образ содержит `pg_dump` для Postgres, `mc` (MinIO client) для
# mirror'инга object storage и `supercronic` для запуска `run.sh` по
# расписанию `BACKUP_CRON`.
#
# Multi-arch (amd64 + arm64) через TARGETARCH BuildKit-аргумент.

FROM alpine:3.20

ARG TARGETARCH
ARG SUPERCRONIC_VERSION=v0.2.32
ARG MC_RELEASE=RELEASE.2025-04-16T18-13-26Z

RUN apk add --no-cache \
        bash \
        ca-certificates \
        curl \
        findutils \
        gzip \
        postgresql16-client \
        tar \
        tzdata && \
    arch="${TARGETARCH:-amd64}"; \
    case "$arch" in amd64|arm64|arm) ;; *) arch=amd64 ;; esac; \
    curl -fsSL "https://dl.min.io/client/mc/release/linux-${arch}/archive/mc.${MC_RELEASE}" \
        -o /usr/local/bin/mc && chmod +x /usr/local/bin/mc; \
    curl -fsSL "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${arch}" \
        -o /usr/local/bin/supercronic && chmod +x /usr/local/bin/supercronic

COPY run.sh /usr/local/bin/run-backup
COPY entrypoint.sh /usr/local/bin/entrypoint
RUN chmod +x /usr/local/bin/run-backup /usr/local/bin/entrypoint

WORKDIR /backups
ENTRYPOINT ["/usr/local/bin/entrypoint"]
