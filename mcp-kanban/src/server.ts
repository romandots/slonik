import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { authenticate, type AuthedRequest } from './auth.js';
import { loadConfig, type Config } from './config.js';
import { McpError } from './errors.js';
import { createLogger, type Logger } from './logger.js';
import { PlaneClient } from './plane-client.js';
import { registerTools, REGISTERED_TOOL_NAMES } from './tools/registry.js';
import { TtlCache } from './cache.js';
import {
  type AgentIdentity,
  type IdentityRegistry,
  createIdentityRegistry,
  createIdentityRegistryFromManifest,
  createIdentityRegistryFromStore,
} from './identity.js';
import { IdentityStore } from './bootstrap/store.js';
import { BOOTSTRAP_STORE_DEFAULT_PATH } from './bootstrap/cli.js';
import { loadManifest } from './bootstrap/manifest.js';
import { AuditLog } from './audit.js';
import { RateLimiter } from './rate-limit.js';
import { GitRefsIndex } from './git-refs.js';
import { MetricsRegistry } from './metrics.js';
import formbody from '@fastify/formbody';
import { OAuthStore } from './oauth/store.js';
import { registerOAuthRoutes } from './oauth/routes.js';
import { resourceUri } from './oauth/metadata.js';
import { hashToken as hashTokenForAuth } from './oauth/crypto.js';

const SERVER_VERSION = readPackageVersion();

export interface BuildServerOptions {
  config: Config;
  logger?: Logger;
  /**
   * Путь к SQLite-стору (`identity.sqlite`). По умолчанию — общий стор по
   * пути в томе `mcp_data`. Тесты могут передать `:memory:` или путь во
   * временной директории.
   */
  identityStorePath?: string;
  /** Путь к audit-логу (`audit.sqlite`). По умолчанию — в томе `mcp_data`. */
  auditStorePath?: string;
  /** Путь к git-refs индексу (`git_refs.sqlite`). По умолчанию — в томе. */
  gitRefsStorePath?: string;
  /** Путь к oauth.sqlite. По умолчанию — общий стор в томе `mcp_data`. */
  oauthStorePath?: string;
}

export const AUDIT_STORE_DEFAULT_PATH = '/mcp_data/audit.sqlite';
export const GIT_REFS_STORE_DEFAULT_PATH = '/mcp_data/git_refs.sqlite';
export const OAUTH_STORE_DEFAULT_PATH = '/mcp_data/oauth.sqlite';

export interface BuiltServer {
  app: FastifyInstance;
  config: Config;
  logger: Logger;
  plane: PlaneClient;
  cache: TtlCache;
  identityStore: IdentityStore;
  audit: AuditLog;
  rateLimiter: RateLimiter;
  gitRefs: GitRefsIndex;
  metrics: MetricsRegistry;
  oauth: OAuthStore | undefined;
  /** Closes Fastify, MCP transports, and SQLite stores. */
  close: () => Promise<void>;
}

/**
 * Создаёт Fastify-приложение и подключает MCP-транспорт. Не запускает
 * listen() — вызывающий код сам решает, на каком порту слушать (в тестах
 * это `fastify.inject`, в продакшне — `app.listen({ port, host })`).
 */
export async function buildServer(opts: BuildServerOptions): Promise<BuiltServer> {
  const { config } = opts;
  const logger = opts.logger ?? createLogger(config);
  // Подключаем наш pino-инстанс. Типы Fastify FastifyBaseLogger строже
  // pino.Logger в одном поле (msgPrefix) — в рантайме они совместимы,
  // поэтому приводим через unknown.
  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    genReqId: () => randomUUID(),
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'trace_id',
    disableRequestLogging: false,
    trustProxy: true,
  });

  const plane = new PlaneClient({ config, logger });
  const cache = new TtlCache({ ttlMs: 10_000 });
  // Identity store открываем «лениво-безопасно»: если файла нет — better-sqlite3
  // создаст пустую БД (и identity mode по факту окажется default из конфига).
  // Bootstrap сам наполнит файл.
  const identityStore = new IdentityStore({
    path: opts.identityStorePath ?? BOOTSTRAP_STORE_DEFAULT_PATH,
  });
  const identityRegistry = buildIdentityRegistry({ store: identityStore, logger });
  logger.info(
    { roles: identityRegistry.list(), size: identityRegistry.size },
    'identity whitelist loaded',
  );
  const audit = new AuditLog({ path: opts.auditStorePath ?? AUDIT_STORE_DEFAULT_PATH });
  const gitRefs = new GitRefsIndex({
    path: opts.gitRefsStorePath ?? GIT_REFS_STORE_DEFAULT_PATH,
  });
  const rateLimiter = new RateLimiter({
    globalRps: config.MCP_RL_GLOBAL_RPS,
    identityRps: config.MCP_RL_IDENTITY_RPS,
  });
  // Phase 8: Prometheus-метрики. Отдельный инстанс per buildServer — это
  // упрощает тесты и параллельный запуск; default-collectors (process_*,
  // nodejs_*) подключаются конструктором MetricsRegistry.
  const metrics = new MetricsRegistry();

  // ---------------- OAuth (optional) ----------------
  // При MCP_OAUTH_ENABLED поднимаем встроенный OAuth 2.1 AS: открываем
  // SQLite-стор, регистрируем discovery/authorize/token-роуты, инжектим
  // identity оператора в whitelist и собираем синхронный валидатор
  // access-токена (audience binds к /mcp этого resource).
  const oauth = config.MCP_OAUTH_ENABLED
    ? new OAuthStore({
        path: opts.oauthStorePath ?? config.MCP_OAUTH_STORE_PATH ?? OAUTH_STORE_DEFAULT_PATH,
        maxClients: config.MCP_OAUTH_MAX_CLIENTS,
      })
    : undefined;

  if (oauth !== undefined && config.MCP_OAUTH_ISSUER !== undefined && config.MCP_OAUTH_ISSUER.startsWith('http://')) {
    logger.warn(
      { issuer: config.MCP_OAUTH_ISSUER },
      'OAuth enabled with a non-HTTPS issuer — tokens travel in plaintext; use HTTPS (external Caddy) in production',
    );
  }

  const expectedResource =
    config.MCP_OAUTH_ISSUER !== undefined ? resourceUri(config.MCP_OAUTH_ISSUER) : undefined;
  const oauthValidator =
    oauth !== undefined
      ? (token: string): { identity: AgentIdentity; scope: string } | undefined => {
          const row = oauth.validateAccessToken(hashTokenForAuth(token), Date.now());
          if (row === undefined) return undefined;
          if (expectedResource !== undefined && row.resource !== expectedResource) return undefined;
          return { identity: row.identity, scope: row.scope };
        }
      : undefined;

  const effectiveRegistry = oauth !== undefined
    ? createIdentityRegistry([...identityRegistry.list(), config.MCP_OAUTH_OPERATOR_IDENTITY])
    : identityRegistry;

  const baseAuthOpts = {
    expectedToken: config.MCP_AUTH_TOKEN,
    identityRegistry: effectiveRegistry,
    ...(oauthValidator !== undefined ? { oauthValidator } : {}),
  };

  // ---------------- /health ----------------
  // Без авторизации; пингует Plane по корневому URL.
  app.get('/health', async () => {
    const planeHealth = await plane.checkHealth();
    return {
      status: 'ok',
      service: 'mcp-kanban',
      version: SERVER_VERSION,
      plane_reachable: planeHealth.reachable,
      plane_status: planeHealth.status,
      plane_latency_ms: planeHealth.latencyMs,
    };
  });

  // ---------------- /metrics ----------------
  // Prometheus scrape endpoint (SPEC §12). Включается через
  // MCP_METRICS_ENABLED=1; иначе возвращает 404, чтобы не светить наружу.
  // Без авторизации — Prometheus scraper в internal_net'е, не на хосте.
  app.get('/metrics', async (_request, reply) => {
    if (!config.MCP_METRICS_ENABLED) {
      reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'metrics disabled' } });
      return;
    }
    reply.header('content-type', metrics.contentType());
    return await metrics.metricsText();
  });

  // ---------------- OAuth routes (optional) ----------------
  // Регистрируем только при включённом флаге. formbody нужен, чтобы
  // парсить application/x-www-form-urlencoded тела authorize/token-роутов.
  if (oauth !== undefined && config.MCP_OAUTH_ISSUER !== undefined) {
    try {
      await app.register(formbody);
      registerOAuthRoutes(app, {
        store: oauth,
        issuer: config.MCP_OAUTH_ISSUER,
        authToken: config.MCP_AUTH_TOKEN,
        operatorIdentity: config.MCP_OAUTH_OPERATOR_IDENTITY,
        accessTtlSec: config.MCP_OAUTH_ACCESS_TTL_SEC,
        refreshTtlSec: config.MCP_OAUTH_REFRESH_TTL_SEC,
        codeTtlSec: config.MCP_OAUTH_CODE_TTL_SEC,
        rateLimiter,
        logger,
      });
    } catch (err) {
      oauth.close();
      throw err;
    }
  }

  // ---------------- /mcp/tools (debug) ----------------
  // Возвращает имена зарегистрированных tool'ов. Требует Bearer-токен;
  // identity не обязательна (это диагностический endpoint, не вызов tool'а).
  app.get('/mcp/tools', async (request, reply) => {
    authenticate(request, reply, { ...baseAuthOpts, requireIdentity: false });
    return { tools: [...REGISTERED_TOOL_NAMES] };
  });

  // ---------------- /mcp ----------------
  // Основной MCP endpoint. StreamableHTTP-транспорт MCP SDK обслуживает
  // и POST (JSON-RPC), и GET/SSE-апгрейд в одном маршруте.
  //
  // Каждый POST с initialize создаёт новую сессию (новая пара
  // McpServer+transport); далее клиент пересылает mcp-session-id и
  // последующие запросы попадают в ту же транспортную сессию.
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  app.all('/mcp', async (request, reply) => {
    authenticate(request, reply, baseAuthOpts);
    const identity = (request as unknown as AuthedRequest).identity;

    const sessionId = headerString(request.headers['mcp-session-id']);
    let transport = sessionId !== undefined ? sessions.get(sessionId) : undefined;

    if (transport === undefined) {
      const newTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          sessions.set(sid, newTransport);
          logger.info({ session: sid, identity }, 'mcp session opened');
        },
      });
      newTransport.onclose = () => {
        const sid = newTransport.sessionId;
        if (sid !== undefined) {
          sessions.delete(sid);
          logger.info({ session: sid }, 'mcp session closed');
        }
      };
      const mcp = new McpServer(
        { name: 'slonk-mcp-kanban', version: SERVER_VERSION },
        { capabilities: { tools: {} } },
      );
      // Identity для tool'ов — берём из замыкания. Если в будущем
      // потребуется per-call идентичность, transport содержит request
      // context — этот hook расширим тогда.
      registerTools(mcp, {
        config,
        serverVersion: SERVER_VERSION,
        plane,
        cache,
        logger,
        resolveIdentity: () => identity,
        resolveIdentityMode: () => {
          const stored = identityStore.getMeta('identity_mode');
          if (stored === 'per_user' || stored === 'single_bot') return stored;
          return config.MCP_AGENT_IDENTITY_MODE;
        },
        defaultWorkspace: config.MCP_DEFAULT_WORKSPACE,
        defaultProjectSlug: config.MCP_DEFAULT_PROJECT,
        allowedProjects: config.MCP_ALLOWED_PROJECTS,
        audit,
        rateLimiter,
        resolvePlaneUserId: () => identityStore.get(identity)?.plane_user_id ?? null,
        minioBucket: config.MINIO_BUCKET_MCP,
        minioEndpoint: config.MINIO_INTERNAL_ENDPOINT,
        signedUrlExpirationSec: config.PLANE_SIGNED_URL_EXPIRATION,
        gitRefs,
        metrics,
      });
      // MCP SDK типы внутри Transport объявляют onclose: () => void как
      // обязательный, а StreamableHTTPServerTransport — как optional;
      // при exactOptionalPropertyTypes: true это разъезжается. В
      // рантайме они полностью совместимы, поэтому cast через Parameters.
      await mcp.connect(newTransport as Parameters<typeof mcp.connect>[0]);
      transport = newTransport;
    }

    // Передаём управление транспорту. Fastify видит `reply.raw` — он
    // напрямую работает с node http ServerResponse. После этого
    // отвечать через `reply` нельзя — транспорт сам закроет соединение.
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // ---------------- error handling ----------------
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof McpError) {
      logger.warn(
        { trace_id: request.id, code: err.code, err: err.message },
        'mcp error response',
      );
      reply.status(err.httpStatus).send({
        error: {
          code: err.code,
          message: err.message,
          trace_id: typeof request.id === 'string' ? request.id : undefined,
        },
      });
      return;
    }
    logger.error({ trace_id: request.id, err }, 'unexpected error');
    reply.status(500).send({
      error: {
        code: 'INTERNAL',
        message: 'Internal server error',
        trace_id: typeof request.id === 'string' ? request.id : undefined,
      },
    });
  });

  const close = async (): Promise<void> => {
    for (const [, t] of sessions) {
      try {
        await t.close();
      } catch {
        // best-effort: продолжаем закрывать остальные
      }
    }
    sessions.clear();
    await app.close();
    try {
      identityStore.close();
    } catch {
      // store уже мог быть закрыт; не критично
    }
    try {
      audit.close();
    } catch {
      // best-effort
    }
    try {
      gitRefs.close();
    } catch {
      // best-effort
    }
    try {
      oauth?.close();
    } catch {
      // best-effort
    }
  };

  return { app, config, logger, plane, cache, identityStore, audit, rateLimiter, gitRefs, metrics, oauth, close };
}

function headerString(v: string | string[] | undefined): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length > 0) return v[0];
  return undefined;
}

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
}

// Re-export для использования в тестах
export {
  type AgentIdentity,
  type IdentityRegistry,
  createIdentityRegistry,
  createIdentityRegistryFromManifest,
  createIdentityRegistryFromStore,
};

/**
 * Собирает реестр идентичностей при старте сервера. Primary-источник — данные,
 * наполненные `make bootstrap` в `identity.sqlite`; fallback — bootstrap
 * manifest (актуален до первого bootstrap'а или если файл стора был стёрт).
 * Если оба источника пусты/невалидны, реестр пустой и любой запрос с
 * `X-Agent-Identity` будет отклонён — это безопасный дефолт; в логах warn
 * объясняет, как починить.
 */
function buildIdentityRegistry(opts: {
  store: IdentityStore;
  logger: Logger;
}): IdentityRegistry {
  const storeRoles = opts.store.all().map((r) => r.role);
  if (storeRoles.length > 0) {
    return createIdentityRegistry(storeRoles);
  }
  try {
    const manifest = loadManifest();
    opts.logger.info(
      { count: manifest.identities.length },
      'identity registry: store empty, falling back to bootstrap manifest',
    );
    return createIdentityRegistryFromManifest(manifest);
  } catch (err) {
    opts.logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'identity registry: store empty and manifest unreadable — ' +
        'whitelist is empty until `make bootstrap` runs successfully',
    );
    return createIdentityRegistry([]);
  }
}

// ---------------- bootstrap ----------------
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const built = await buildServer({ config, logger });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    try {
      await built.close();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'shutdown error');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await built.app.listen({ port: config.MCP_SERVER_PORT, host: '0.0.0.0' });
  logger.info(
    { port: config.MCP_SERVER_PORT, version: SERVER_VERSION },
    'mcp-kanban listening',
  );
}

// CLI-диспетчер: первая позиционная команда (если есть) определяет режим.
//   (нет)         — запуск HTTP-сервера (см. main()).
//   bootstrap     — идемпотентный bootstrap Plane.
async function dispatch(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'bootstrap') {
    const { bootstrapCli } = await import('./bootstrap/cli.js');
    await bootstrapCli();
    return;
  }
  if (cmd !== undefined && cmd !== '') {
    // eslint-disable-next-line no-console
    console.error(`Unknown command: ${cmd}`);
    process.exit(2);
  }
  await main();
}

// Запускаем только если файл — entrypoint (не импортируется из тестов).
const isEntrypoint = process.argv[1] !== undefined
  && import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) {
  dispatch().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}
