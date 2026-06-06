import type { FastifyReply, FastifyRequest } from 'fastify';
import { McpError } from './errors.js';
import type { AgentIdentity, IdentityRegistry } from './identity.js';
import { hashToken } from './oauth/crypto.js';

const AUTH_SCHEME = /^Bearer\s+(.+)$/i;

export interface AuthedRequest extends FastifyRequest {
  identity: AgentIdentity;
  /** Workspace slug тенанта, разрешённый при аутентификации. */
  workspace: string;
}

export interface AuthOptions {
  expectedToken: string;
  /** Workspace по умолчанию — используется для static-token path без явного тенанта. */
  defaultWorkspace: string;
  /** Если false — проверяется только Bearer, identity не нужна. */
  requireIdentity?: boolean;
  /**
   * Whitelist допустимых X-Agent-Identity. Обязателен, если
   * `requireIdentity !== false`. Реестр строится один раз в `buildServer`:
   * primary — `IdentityStore` (после bootstrap), fallback —
   * bootstrap manifest.
   */
  identityRegistry?: IdentityRegistry;
  /**
   * Опциональный валидатор OAuth access-токена. Если presented Bearer не
   * равен статичному expectedToken — пробуем его как OAuth-токен. Успех →
   * identity и workspace берутся из токена, X-Agent-Identity не требуется.
   * Sync, потому что lookup идёт в better-sqlite3 (синхронный).
   */
  oauthValidator?: (token: string) => { identity: AgentIdentity; scope: string; workspace: string } | undefined;
  /**
   * Опциональный lookup тенанта по хэшу статик-токена. Если задан —
   * static Bearer path резолвит workspace из стора, иначе — defaultWorkspace.
   */
  tenantByAuthTokenHash?: (hash: string) => { workspace: string } | undefined;
}

/**
 * Проверяет Bearer-токен и (по умолчанию) X-Agent-Identity. При успехе
 * мутирует `request.identity`. При неуспехе кидает McpError; обработчик
 * onError превращает её в правильный HTTP-ответ.
 */
export function authenticate(
  request: FastifyRequest,
  _reply: FastifyReply,
  options: AuthOptions,
): void {
  const auth = request.headers['authorization'];
  if (typeof auth !== 'string' || auth.length === 0) {
    throw new McpError({ code: 'UNAUTHORIZED', message: 'Missing Authorization header' });
  }
  const match = AUTH_SCHEME.exec(auth);
  if (match === null) {
    throw new McpError({ code: 'UNAUTHORIZED', message: 'Authorization must be a Bearer token' });
  }
  const presented = match[1];
  if (presented === undefined) {
    throw new McpError({ code: 'UNAUTHORIZED', message: 'Invalid bearer token' });
  }

  // Path A — статичный shared-token: identity из X-Agent-Identity (как было).
  if (constantTimeEqual(presented, options.expectedToken)) {
    applyStaticIdentity(request, options);
    // Workspace: ищем тенанта по хэшу токена; fallback — defaultWorkspace.
    if (options.tenantByAuthTokenHash !== undefined) {
      const hash = hashToken(presented);
      const tenant = options.tenantByAuthTokenHash(hash);
      (request as AuthedRequest).workspace = tenant?.workspace ?? options.defaultWorkspace;
    } else {
      (request as AuthedRequest).workspace = options.defaultWorkspace;
    }
    return;
  }

  // Path B — OAuth access-токен (если включён валидатор). Identity из токена
  // дополнительно сверяется с реестром — auth.ts не полагается на внешний
  // инвариант, что operator заинжектен в whitelist (defense-in-depth).
  // scope резолвится валидатором; его enforcement — ответственность валидатора
  // (на текущей модели единый scope 'mcp'), здесь он не проверяется.
  if (options.oauthValidator !== undefined) {
    const resolved = options.oauthValidator(presented);
    if (resolved !== undefined) {
      if (options.identityRegistry !== undefined && !options.identityRegistry.has(resolved.identity)) {
        throw new McpError({
          code: 'IDENTITY_REQUIRED',
          message: `Unknown agent identity: ${resolved.identity}`,
        });
      }
      (request as AuthedRequest).identity = resolved.identity;
      (request as AuthedRequest).workspace = resolved.workspace || options.defaultWorkspace;
      return;
    }
  }

  throw new McpError({ code: 'UNAUTHORIZED', message: 'Invalid bearer token' });
}

function applyStaticIdentity(request: FastifyRequest, options: AuthOptions): void {
  if (options.requireIdentity === false) return;
  if (options.identityRegistry === undefined) {
    throw new McpError({ code: 'INTERNAL', message: 'identity registry not configured' });
  }
  const idHeader = request.headers['x-agent-identity'];
  const id = Array.isArray(idHeader) ? idHeader[0] : idHeader;
  if (typeof id !== 'string' || id.length === 0) {
    throw new McpError({ code: 'IDENTITY_REQUIRED', message: 'X-Agent-Identity header required' });
  }
  if (!options.identityRegistry.has(id)) {
    throw new McpError({ code: 'IDENTITY_REQUIRED', message: `Unknown agent identity: ${id}` });
  }
  (request as AuthedRequest).identity = id;
}

/**
 * Сравнение строк за константное время — защита от timing attack на
 * угадывание токена.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
