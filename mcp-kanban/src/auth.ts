import type { FastifyReply, FastifyRequest } from 'fastify';
import { McpError } from './errors.js';
import { isAgentIdentity, type AgentIdentity } from './identity.js';

const AUTH_SCHEME = /^Bearer\s+(.+)$/i;

export interface AuthedRequest extends FastifyRequest {
  identity: AgentIdentity;
}

export interface AuthOptions {
  expectedToken: string;
  /** Если false — проверяется только Bearer, identity не нужна. */
  requireIdentity?: boolean;
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
  if (presented === undefined || !constantTimeEqual(presented, options.expectedToken)) {
    throw new McpError({ code: 'UNAUTHORIZED', message: 'Invalid bearer token' });
  }

  if (options.requireIdentity !== false) {
    const idHeader = request.headers['x-agent-identity'];
    const id = Array.isArray(idHeader) ? idHeader[0] : idHeader;
    if (typeof id !== 'string' || id.length === 0) {
      throw new McpError({ code: 'IDENTITY_REQUIRED', message: 'X-Agent-Identity header required' });
    }
    if (!isAgentIdentity(id)) {
      throw new McpError({
        code: 'IDENTITY_REQUIRED',
        message: `Unknown agent identity: ${id}`,
      });
    }
    (request as AuthedRequest).identity = id;
  }
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
