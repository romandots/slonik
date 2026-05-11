import type { Config } from '../config.js';
import type { AgentIdentity } from '../identity.js';
import type { Logger } from '../logger.js';
import type { PlaneClient } from '../plane-client.js';
import type { TtlCache } from '../cache.js';
import type { AuditLog } from '../audit.js';
import type { RateLimiter } from '../rate-limit.js';
import type { GitRefsIndex } from '../git-refs.js';
import type { MetricsRegistry } from '../metrics.js';

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
   * Workspace slug по умолчанию (`MCP_DEFAULT_WORKSPACE`).
   */
  defaultWorkspace: string;
  /**
   * Project identifier (например, `SLONK`) или slug — выбирается tool'ом.
   * Тут сохраняем оба, чтобы tool сам резолвил.
   */
  defaultProjectSlug: string;
  /** Список разрешённых проектов (slug/identifier). */
  allowedProjects: string[];
  /** Audit log (SQLite). Write-tools обязаны писать сюда каждое действие. */
  audit: AuditLog;
  /** Rate limiter. Write-tools зовут .consume() перед Plane-вызовом. */
  rateLimiter: RateLimiter;
  /** Возвращает plane_user_id текущей identity, если known. */
  resolvePlaneUserId: () => string | null;
  /** MinIO endpoint и bucket для attach_file. */
  minioEndpoint: string;
  minioBucket: string;
  /** TTL presigned URL'ов в секундах. */
  signedUrlExpirationSec: number;
  /** SQLite-индекс git-привязок (Phase 6). */
  gitRefs: GitRefsIndex;
  /** Prometheus-метрики (Phase 8). */
  metrics: MetricsRegistry;
}
