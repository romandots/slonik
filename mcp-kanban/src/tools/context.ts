import type { Config } from '../config.js';
import type { AgentIdentity } from '../identity.js';
import type { Logger } from '../logger.js';
import type { PlaneClient } from '../plane-client.js';
import type { TtlCache } from '../cache.js';
import type { AuditLog } from '../audit.js';
import type { IdentityStore } from '../bootstrap/store.js';
import type { RateLimiter } from '../rate-limit.js';
import type { GitRefsIndex } from '../git-refs.js';
import type { MetricsRegistry } from '../metrics.js';
import type { MinioClient } from '../minio-client.js';

// Shared context для всех MCP tool'ов. Содержит то, что tool'ам нужно:
// конфиг, идентичность вызывающего, обёртку Plane API, общий кеш.

export interface ToolContext {
  config: Config;
  serverVersion: string;
  plane: PlaneClient;
  cache: TtlCache;
  logger: Logger;
  /** Identity, ассоциированная с текущей MCP-сессией (см. server.ts). */
  resolveIdentity: () => AgentIdentity;
  /** Active identity mode из bootstrap-store (либо config-default). */
  resolveIdentityMode: () => 'per_user' | 'single_bot';
  /**
   * Workspace slug текущего тенанта — берётся из OAuth-токена или
   * из static-token lookup. Никогда не берётся из параметра запроса.
   */
  workspace: string;
  /**
   * Project identifier (например, `SLONK`) или slug — выбирается tool'ом.
   * Тут сохраняем оба, чтобы tool сам резолвил.
   */
  defaultProjectSlug: string;
  /** Audit log (SQLite). Write-tools обязаны писать сюда каждое действие. */
  audit: AuditLog;
  /**
   * Identity-стор (SQLite). `claim_issue` читает отсюда `default_state`
   * и `state_aliases` для маппинга «роль → колонка» (SLONK-6).
   */
  identityStore: IdentityStore;
  /** Rate limiter. Write-tools зовут .consume() перед Plane-вызовом. */
  rateLimiter: RateLimiter;
  /** Возвращает plane_user_id текущей identity, если known. */
  resolvePlaneUserId: () => string | null;
  /** MinIO bucket для attach_file. */
  minioBucket: string;
  /**
   * MinIO bucket для UI-аплоадов Plane (`MINIO_BUCKET_PLANE`,
   * default `plane-uploads`). Используется в attachments discovery
   * (SLONK-14).
   */
  minioBucketPlane: string;
  /**
   * Список known MinIO endpoints (origin'ы — `MINIO_PUBLIC_ENDPOINT`
   * + `MINIO_INTERNAL_ENDPOINT`). Используется как whitelist в
   * SSRF-фильтре парсера inline-asset'ов.
   */
  minioEndpoints: string[];
  /**
   * Known Plane UI/API origins для inline asset-API URL'ов (`/api/assets/...`).
   * Используется только как origin-whitelist при парсинге HTML.
   */
  planeAssetEndpoints: string[];
  /**
   * MinIO-клиент (presign / stat / list). В тестах подсовывается
   * `FakeMinioClient`. SLONK-14.
   */
  minio: MinioClient;
  /** TTL presigned URL'ов в секундах. */
  signedUrlExpirationSec: number;
  /**
   * Максимальный размер decoded direct-аплоада в байтах
   * (`MCP_ATTACH_MAX_BYTES`). Единый source-of-truth по лимиту attach_file —
   * раньше дублировался хардкодами в schema/handler (SLONK-31).
   */
  attachMaxBytes: number;
  /**
   * MIME-allowlist для direct-аплоада (`MCP_ATTACH_ALLOWED_MIME`). Пусто =
   * разрешены любые типы (backward compat); непустой — direct отвергает прочие.
   */
  attachAllowedMime: string[];
  /** SQLite-индекс git-привязок (Phase 6). */
  gitRefs: GitRefsIndex;
  /** Prometheus-метрики (Phase 8). */
  metrics: MetricsRegistry;
}
