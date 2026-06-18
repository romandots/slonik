import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Logger } from '../logger.js';
import type { RateLimiter } from '../rate-limit.js';
import { OAuthStore } from './store.js';
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  resourceUri,
  OAUTH_SCOPE,
} from './metadata.js';
import { generateOpaqueToken, hashToken, verifyPkceS256, constantTimeEqual } from './crypto.js';
import { WORKSPACE_SLUG_RE } from './defaults.js';

export interface OAuthRouteDeps {
  store: OAuthStore;
  issuer: string;
  /** Глобальный fallback auth-токен (MCP_AUTH_TOKEN). Используется если
   *  workspace не найден в стор тенантов или OAuth выключен. */
  authToken: string;
  /** Workspace по умолчанию (MCP_DEFAULT_WORKSPACE). */
  defaultWorkspace: string;
  operatorIdentity: string;
  accessTtlSec: number;
  refreshTtlSec: number;
  codeTtlSec: number;
  rateLimiter: RateLimiter;
  logger: Logger;
  /** Override of "now" in ms for tests. */
  now?: () => number;
}

const RegisterBody = z.object({
  client_name: z.string().min(1).max(256).optional().default('mcp-client'),
  redirect_uris: z.array(z.string().url().max(512)).min(1).max(10),
});

const AuthorizeQuery = z.object({
  response_type: z.literal('code').optional().default('code'),
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  code_challenge: z.string().min(1),
  code_challenge_method: z.literal('S256'),
  state: z.string().optional().default(''),
  resource: z.string().url().optional(),
  scope: z.string().optional(),
  /** Workspace slug тенанта. Если не передан — используется workspace по умолчанию.
   *  Валидируется тем же slug-regex, что add-tenant/bootstrap: bounded length +
   *  без мусора (защита от длинного ввода и нечитаемых slug'ов в форме/коде). */
  workspace: z.string().min(1).max(64).regex(WORKSPACE_SLUG_RE).optional(),
});

const AuthorizePost = AuthorizeQuery.extend({ password: z.string().min(1) });

export function registerOAuthRoutes(app: FastifyInstance, deps: OAuthRouteDeps): void {
  const now = deps.now ?? Date.now;
  const expectedResource = resourceUri(deps.issuer);

  // Anti-clickjacking заголовки для всех HTML-ответов authorize-flow.
  const htmlSecurityHeaders = (reply: FastifyReply): void => {
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  };

  // ---- discovery ----
  app.get('/.well-known/oauth-protected-resource', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return buildProtectedResourceMetadata(deps.issuer);
  });
  app.get('/.well-known/oauth-authorization-server', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return buildAuthorizationServerMetadata(deps.issuer);
  });

  // ---- DCR (RFC 7591), open with cap+rate-limit ----
  app.post('/oauth/register', async (request, reply) => {
    try {
      deps.rateLimiter.consume('oauth-register');
    } catch {
      reply.status(429);
      return { error: 'temporarily_unavailable', error_description: 'rate limit exceeded' };
    }
    const parsed = RegisterBody.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'invalid_client_metadata', error_description: parsed.error.message };
    }
    let client;
    try {
      client = deps.store.registerClient({
        client_name: parsed.data.client_name,
        redirect_uris: parsed.data.redirect_uris,
        created_at_ms: now(),
      });
    } catch (err) {
      reply.status(429);
      deps.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'oauth client cap reached',
      );
      return { error: 'temporarily_unavailable', error_description: 'client registration cap reached' };
    }
    reply.status(201);
    return {
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  });

  // ---- authorize (GET -> login form) ----
  app.get('/oauth/authorize', async (request, reply) => {
    const parsed = AuthorizeQuery.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400).type('text/html');
      htmlSecurityHeaders(reply);
      return renderError('Invalid authorization request');
    }
    const q = parsed.data;
    const client = deps.store.getClient(q.client_id);
    if (client === undefined || !client.redirect_uris.includes(q.redirect_uri)) {
      reply.status(400).type('text/html');
      htmlSecurityHeaders(reply);
      return renderError('Unknown client or redirect_uri mismatch');
    }
    if (q.resource !== undefined && q.resource !== expectedResource) {
      reply.status(400).type('text/html');
      htmlSecurityHeaders(reply);
      return renderError('resource mismatch');
    }
    if (q.scope !== undefined && q.scope !== OAUTH_SCOPE) {
      reply.status(400).type('text/html');
      htmlSecurityHeaders(reply);
      return renderError('invalid scope');
    }
    reply.status(200).type('text/html');
    htmlSecurityHeaders(reply);
    return renderLoginForm(q, deps.defaultWorkspace);
  });

  // ---- authorize (POST -> issue code) ----
  app.post('/oauth/authorize', async (request, reply) => {
    try {
      deps.rateLimiter.consume('oauth-authorize');
    } catch {
      reply.status(429).type('text/html');
      htmlSecurityHeaders(reply);
      return renderError('Too many requests. Try again shortly.');
    }
    const parsed = AuthorizePost.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'invalid_request', error_description: parsed.error.message };
    }
    const q = parsed.data;
    const client = deps.store.getClient(q.client_id);
    if (client === undefined || !client.redirect_uris.includes(q.redirect_uri)) {
      reply.status(400);
      return { error: 'invalid_request', error_description: 'redirect_uri mismatch' };
    }
    if (q.resource !== undefined && q.resource !== expectedResource) {
      reply.status(400);
      return { error: 'invalid_request', error_description: 'resource mismatch' };
    }
    if (q.scope !== undefined && q.scope !== OAUTH_SCOPE) {
      reply.status(400);
      return { error: 'invalid_scope' };
    }
    // Резолвим workspace (SLONK-19: оператор вводит его в форме, т.к.
    // claude.ai не пробрасывает ?workspace= в authorize) и проверяем пароль:
    // сначала ищем тенанта, затем fallback на глобальный MCP_AUTH_TOKEN —
    // только для дефолтного workspace.
    const targetWorkspace = q.workspace ?? deps.defaultWorkspace ?? '';
    const tenant = deps.store.getTenantByWorkspace(targetWorkspace);

    // Если оператор ЯВНО ввёл workspace, который не дефолтный и без тенанта —
    // отклоняем, а не проваливаемся в fallback на MCP_AUTH_TOKEN: иначе ввод
    // произвольной строки + глобальный токен авторизовал бы к несуществующему
    // workspace. Когда поле не задано (старый флоу без workspace) — не трогаем.
    if (
      q.workspace !== undefined &&
      tenant === undefined &&
      q.workspace !== deps.defaultWorkspace
    ) {
      reply.status(400).type('text/html');
      htmlSecurityHeaders(reply);
      return renderLoginForm(q, deps.defaultWorkspace, `Unknown workspace: ${q.workspace}`);
    }

    let passwordOk: boolean;
    if (tenant !== undefined) {
      passwordOk = constantTimeEqual(hashToken(q.password), tenant.auth_token_hash);
    } else {
      // tenant === undefined здесь возможно только при targetWorkspace ===
      // defaultWorkspace (дефолтный тенант не авто-зарегистрирован, например
      // PLANE_API_KEY не задан) — backward-compat сверка с MCP_AUTH_TOKEN.
      // Хэшируем обе стороны, как в tenant-ветке, чтобы семантика сверки была
      // одинаковой (hash-to-hash) и не зависела от внутренней реализации
      // constantTimeEqual.
      passwordOk = constantTimeEqual(hashToken(q.password), hashToken(deps.authToken));
    }

    if (!passwordOk) {
      reply.status(401).type('text/html');
      htmlSecurityHeaders(reply);
      return renderLoginForm(q, deps.defaultWorkspace, 'Invalid password');
    }
    const code = generateOpaqueToken();
    deps.store.saveCode({
      code_hash: hashToken(code),
      client_id: q.client_id,
      redirect_uri: q.redirect_uri,
      code_challenge: q.code_challenge,
      identity: deps.operatorIdentity,
      scope: q.scope ?? OAUTH_SCOPE,
      resource: expectedResource,
      workspace: targetWorkspace,
      expires_at_ms: now() + deps.codeTtlSec * 1000,
    });
    const loc = new URL(q.redirect_uri);
    loc.searchParams.set('code', code);
    if (q.state !== '') loc.searchParams.set('state', q.state);
    reply.status(302).header('location', loc.toString());
    return null;
  });

  // ---- token ----
  app.post('/oauth/token', async (request, reply) => {
    try {
      deps.rateLimiter.consume('oauth-token');
    } catch {
      reply.status(429);
      return { error: 'temporarily_unavailable' };
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const grant = body['grant_type'];
    if (grant === 'authorization_code') return handleAuthCodeGrant(body, reply);
    if (grant === 'refresh_token') return handleRefreshGrant(body, reply);
    reply.status(400);
    return { error: 'unsupported_grant_type' };
  });

  // ---- revoke (RFC 7009) ----
  app.post('/oauth/revoke', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const token = typeof body['token'] === 'string' ? body['token'] : undefined;
    if (token !== undefined) deps.store.revokeChainByToken(hashToken(token));
    reply.status(200);
    return {};
  });

  function handleAuthCodeGrant(body: Record<string, unknown>, reply: FastifyReply) {
    const code = str(body['code']);
    const redirectUri = str(body['redirect_uri']);
    const clientId = str(body['client_id']);
    const verifier = str(body['code_verifier']);
    if (code === undefined || redirectUri === undefined || clientId === undefined || verifier === undefined) {
      reply.status(400);
      return { error: 'invalid_request' };
    }
    const row = deps.store.consumeCode(hashToken(code), now());
    if (row === undefined || row.client_id !== clientId || row.redirect_uri !== redirectUri) {
      reply.status(400);
      return { error: 'invalid_grant' };
    }
    if (!verifyPkceS256(verifier, row.code_challenge)) {
      reply.status(400);
      return { error: 'invalid_grant', error_description: 'PKCE verification failed' };
    }
    return issueTokenPair(row.client_id, row.identity, row.scope, row.resource, row.workspace, generateOpaqueToken(), reply);
  }

  function handleRefreshGrant(body: Record<string, unknown>, reply: FastifyReply) {
    const refresh = str(body['refresh_token']);
    const clientId = str(body['client_id']);
    if (refresh === undefined || clientId === undefined) {
      reply.status(400);
      return { error: 'invalid_request' };
    }
    const row = deps.store.consumeRefreshToken(hashToken(refresh), now());
    if (row === undefined || row.client_id !== clientId) {
      reply.status(400);
      return { error: 'invalid_grant' };
    }
    return issueTokenPair(row.client_id, row.identity, row.scope, row.resource, row.workspace, row.refresh_chain_id, reply);
  }

  function issueTokenPair(
    clientId: string,
    identity: string,
    scope: string,
    resource: string,
    workspace: string,
    chainId: string,
    reply: FastifyReply,
  ) {
    const access = generateOpaqueToken();
    const refresh = generateOpaqueToken();
    const t = now();
    deps.store.saveToken({
      token_hash: hashToken(access),
      kind: 'access',
      client_id: clientId,
      identity,
      scope,
      resource,
      workspace,
      expires_at_ms: t + deps.accessTtlSec * 1000,
      refresh_chain_id: chainId,
    });
    deps.store.saveToken({
      token_hash: hashToken(refresh),
      kind: 'refresh',
      client_id: clientId,
      identity,
      scope,
      resource,
      workspace,
      expires_at_ms: t + deps.refreshTtlSec * 1000,
      refresh_chain_id: chainId,
    });
    reply.status(200).header('cache-control', 'no-store').header('pragma', 'no-cache');
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: deps.accessTtlSec,
      scope,
    };
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

function renderLoginForm(
  q: z.infer<typeof AuthorizeQuery>,
  defaultWorkspace: string,
  errorMsg?: string,
): string {
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  // SLONK-19: workspace — редактируемое поле. claude.ai не передаёт ?workspace=
  // в authorize, поэтому оператор вводит его здесь, чтобы выбрать тенанта.
  // Префилл — введённое ранее значение (при ре-рендере ошибки) либо дефолт.
  const workspaceValue = q.workspace ?? defaultWorkspace;
  return `<!doctype html><html><head><meta charset="utf-8"><title>slonk · authorize</title></head>
<body style="font-family:system-ui;max-width:28rem;margin:4rem auto;">
  <h1>Authorize slonk MCP</h1>
  ${errorMsg ? `<p style="color:#b00">${escapeHtml(errorMsg)}</p>` : ''}
  <form method="POST" action="/oauth/authorize">
    ${hidden('response_type', q.response_type)}
    ${hidden('client_id', q.client_id)}
    ${hidden('redirect_uri', q.redirect_uri)}
    ${hidden('code_challenge', q.code_challenge)}
    ${hidden('code_challenge_method', q.code_challenge_method)}
    ${hidden('state', q.state)}
    ${q.resource !== undefined ? hidden('resource', q.resource) : ''}
    ${q.scope !== undefined ? hidden('scope', q.scope) : ''}
    <label>Workspace<br><input type="text" name="workspace" required maxlength="64"
      ${errorMsg ? 'autofocus' : ''} value="${escapeHtml(workspaceValue)}"
      style="width:100%;padding:.5rem;margin:.5rem 0;"></label>
    <label>Operator password<br><input type="password" name="password" ${errorMsg ? '' : 'autofocus'}
      style="width:100%;padding:.5rem;margin:.5rem 0;"></label>
    <button type="submit" style="padding:.5rem 1rem;">Authorize</button>
  </form>
</body></html>`;
}

function renderError(msg: string): string {
  return `<!doctype html><html><body style="font-family:system-ui;max-width:28rem;margin:4rem auto;">
  <h1>Authorization error</h1><p>${escapeHtml(msg)}</p></body></html>`;
}
