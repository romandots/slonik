import type { FastifyReply, FastifyRequest } from 'fastify';
import { McpError } from './errors.js';
import type { AgentIdentity, IdentityRegistry } from './identity.js';

const AUTH_SCHEME = /^Bearer\s+(.+)$/i;

export interface AuthedRequest extends FastifyRequest {
  identity: AgentIdentity;
}

export interface AuthOptions {
  expectedToken: string;
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
   * identity берётся из токена, X-Agent-Identity не требуется. Sync, потому
   * что lookup идёт в better-sqlite3 (синхронный).
   */
  oauthValidator?: (token: string) => { identity: AgentIdentity; scope: string } | undefined;
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
    return;
  }

  // Path B — OAuth access-токен (если включён валидатор).
  if (options.oauthValidator !== undefined) {
    const resolved = options.oauthValidator(presented);
    if (resolved !== undefined) {
      (request as AuthedRequest).identity = resolved.identity;
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
