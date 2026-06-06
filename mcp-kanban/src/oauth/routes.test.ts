import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { randomBytes, createHash } from 'node:crypto';
import { OAuthStore } from './store.js';
import { registerOAuthRoutes } from './routes.js';
import { createLogger } from '../logger.js';
import { RateLimiter } from '../rate-limit.js';

const ISSUER = 'https://slonk.example.com';
const STATIC_TOKEN = 'p'.repeat(40);
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

describe('oauth routes (full flow)', () => {
  let app: FastifyInstance;
  let store: OAuthStore;

  beforeEach(async () => {
    store = new OAuthStore({ path: ':memory:', maxClients: 10 });
    app = Fastify();
    await app.register(formbody);
    registerOAuthRoutes(app, {
      store,
      issuer: ISSUER,
      authToken: STATIC_TOKEN,
      defaultWorkspace: 'agents',
      operatorIdentity: 'operator',
      accessTtlSec: 3600,
      refreshTtlSec: 2_592_000,
      codeTtlSec: 60,
      rateLimiter: new RateLimiter({ globalRps: 1000, identityRps: 1000 }),
      logger: createLogger({ MCP_LOG_LEVEL: 'fatal', NODE_ENV: 'test' }),
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    store.close();
  });

  it('serves protected-resource metadata', async () => {
    const r = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).resource).toBe('https://slonk.example.com/mcp');
  });

  it('serves authorization-server metadata', async () => {
    const r = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).code_challenge_methods_supported).toEqual(['S256']);
  });

  it('runs register -> authorize -> token -> refresh', async () => {
    const reg = await app.inject({
      method: 'POST', url: '/oauth/register',
      payload: { client_name: 'claude.ai', redirect_uris: [REDIRECT] },
    });
    expect(reg.statusCode).toBe(201);
    const clientId = JSON.parse(reg.body).client_id as string;
    expect(clientId).toBeTruthy();

    const { verifier, challenge } = pkce();
    const authQuery =
      `?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}` +
      `&code_challenge=${challenge}&code_challenge_method=S256&state=xyz&resource=${encodeURIComponent(ISSUER + '/mcp')}`;
    const form = await app.inject({ method: 'GET', url: `/oauth/authorize${authQuery}` });
    expect(form.statusCode).toBe(200);
    expect(form.body).toContain('<form');

    const post = await app.inject({
      method: 'POST', url: '/oauth/authorize',
      payload: {
        password: STATIC_TOKEN, client_id: clientId, redirect_uri: REDIRECT,
        code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz',
        resource: `${ISSUER}/mcp`,
      },
    });
    expect(post.statusCode).toBe(302);
    const location = new URL(post.headers.location as string);
    expect(location.searchParams.get('state')).toBe('xyz');
    const code = location.searchParams.get('code') as string;
    expect(code).toBeTruthy();

    const tok = await app.inject({
      method: 'POST', url: '/oauth/token',
      payload: {
        grant_type: 'authorization_code', code, redirect_uri: REDIRECT,
        client_id: clientId, code_verifier: verifier,
      },
    });
    expect(tok.statusCode).toBe(200);
    const body = JSON.parse(tok.body);
    expect(body.token_type).toBe('Bearer');
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
    expect(body.expires_in).toBe(3600);

    const refreshed = await app.inject({
      method: 'POST', url: '/oauth/token',
      payload: { grant_type: 'refresh_token', refresh_token: body.refresh_token, client_id: clientId },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(JSON.parse(refreshed.body).access_token).not.toBe(body.access_token);
  });

  it('rejects a wrong operator password', async () => {
    const reg = await app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'c', redirect_uris: [REDIRECT] } });
    const clientId = JSON.parse(reg.body).client_id as string;
    const { challenge } = pkce();
    const post = await app.inject({
      method: 'POST', url: '/oauth/authorize',
      payload: { password: 'wrong', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: `${ISSUER}/mcp` },
    });
    expect(post.statusCode).toBe(401);
  });

  it('rejects an unregistered redirect_uri at authorize', async () => {
    const reg = await app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'c', redirect_uris: [REDIRECT] } });
    const clientId = JSON.parse(reg.body).client_id as string;
    const { challenge } = pkce();
    const r = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('https://evil/cb')}&code_challenge=${challenge}&code_challenge_method=S256&state=s&resource=${encodeURIComponent(ISSUER + '/mcp')}`,
    });
    expect(r.statusCode).toBe(400);
  });

  it('rejects a token exchange with a wrong PKCE verifier', async () => {
    const reg = await app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'c', redirect_uris: [REDIRECT] } });
    const clientId = JSON.parse(reg.body).client_id as string;
    const { challenge } = pkce();
    const post = await app.inject({
      method: 'POST', url: '/oauth/authorize',
      payload: { password: STATIC_TOKEN, client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: `${ISSUER}/mcp` },
    });
    const code = new URL(post.headers.location as string).searchParams.get('code') as string;
    const tok = await app.inject({
      method: 'POST', url: '/oauth/token',
      payload: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: 'wrong' },
    });
    expect(tok.statusCode).toBe(400);
  });

  it('rejects reusing an authorization code', async () => {
    const reg = await app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'c', redirect_uris: [REDIRECT] } });
    const clientId = JSON.parse(reg.body).client_id as string;
    const { verifier, challenge } = pkce();
    const post = await app.inject({
      method: 'POST', url: '/oauth/authorize',
      payload: { password: STATIC_TOKEN, client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: `${ISSUER}/mcp` },
    });
    const code = new URL(post.headers.location as string).searchParams.get('code') as string;
    const first = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier } });
    expect(second.statusCode).toBe(400);
  });

  async function registerClient(): Promise<string> {
    const reg = await app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'c', redirect_uris: [REDIRECT] } });
    return JSON.parse(reg.body).client_id as string;
  }

  async function getTokenPair(): Promise<{ clientId: string; access_token: string; refresh_token: string }> {
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const post = await app.inject({
      method: 'POST', url: '/oauth/authorize',
      payload: { password: STATIC_TOKEN, client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: `${ISSUER}/mcp` },
    });
    const code = new URL(post.headers.location as string).searchParams.get('code') as string;
    const tok = await app.inject({
      method: 'POST', url: '/oauth/token',
      payload: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier },
    });
    const body = JSON.parse(tok.body);
    return { clientId, access_token: body.access_token as string, refresh_token: body.refresh_token as string };
  }

  it('rejects an expired authorization code at the token endpoint', async () => {
    let clock = 1_000_000;
    const s = new OAuthStore({ path: ':memory:', maxClients: 10 });
    const a = Fastify();
    await a.register(formbody);
    registerOAuthRoutes(a, {
      store: s, issuer: ISSUER, authToken: STATIC_TOKEN, operatorIdentity: 'operator',
      accessTtlSec: 3600, refreshTtlSec: 2_592_000, codeTtlSec: 60,
      rateLimiter: new RateLimiter({ globalRps: 1000, identityRps: 1000 }),
      logger: createLogger({ MCP_LOG_LEVEL: 'fatal', NODE_ENV: 'test' }),
      now: () => clock,
    });
    await a.ready();
    const reg = await a.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'c', redirect_uris: [REDIRECT] } });
    const clientId = JSON.parse(reg.body).client_id as string;
    const { verifier, challenge } = pkce();
    const post = await a.inject({ method: 'POST', url: '/oauth/authorize', payload: { password: STATIC_TOKEN, client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: `${ISSUER}/mcp` } });
    const code = new URL(post.headers.location as string).searchParams.get('code') as string;
    clock += 61_000; // code TTL is 60s
    const tok = await a.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier } });
    expect(tok.statusCode).toBe(400);
    await a.close(); s.close();
  });

  it('rejects an unsupported grant_type', async () => {
    const r = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'client_credentials' } });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toBe('unsupported_grant_type');
  });

  it('revokes a refresh token and is idempotent for unknown tokens', async () => {
    const { clientId, refresh_token } = await getTokenPair();
    const revoke = await app.inject({ method: 'POST', url: '/oauth/revoke', payload: { token: refresh_token } });
    expect(revoke.statusCode).toBe(200);
    const refreshed = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token, client_id: clientId } });
    expect(refreshed.statusCode).toBe(400);
    const unknown = await app.inject({ method: 'POST', url: '/oauth/revoke', payload: { token: 'unknown' } });
    expect(unknown.statusCode).toBe(200);
  });

  it('refresh rotation invalidates the old refresh token (chain poison) at HTTP layer', async () => {
    const { clientId, refresh_token } = await getTokenPair();
    const first = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token, client_id: clientId } });
    expect(first.statusCode).toBe(200);
    const rotated = JSON.parse(first.body).refresh_token as string;
    const reuse = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token, client_id: clientId } });
    expect(reuse.statusCode).toBe(400);
    const rotatedUse = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: rotated, client_id: clientId } });
    expect(rotatedUse.statusCode).toBe(400);
  });

  it('sets anti-clickjacking headers on the authorize form', async () => {
    const reg = await app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'c', redirect_uris: [REDIRECT] } });
    const clientId = JSON.parse(reg.body).client_id as string;
    const { challenge } = pkce();
    const r = await app.inject({ method: 'GET', url: `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&state=s&resource=${encodeURIComponent(ISSUER + '/mcp')}` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(String(r.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });

  it('discovery sets cache-control: no-store', async () => {
    const r = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' });
    expect(r.headers['cache-control']).toContain('no-store');
  });

  // ---- SLONK-19: workspace выбирается в форме логина ----

  async function newClient(): Promise<string> {
    const reg = await app.inject({
      method: 'POST', url: '/oauth/register',
      payload: { client_name: 'claude.ai', redirect_uris: [REDIRECT] },
    });
    return JSON.parse(reg.body).client_id as string;
  }

  function authQuery(clientId: string, challenge: string): string {
    return `?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}` +
      `&code_challenge=${challenge}&code_challenge_method=S256&state=s&resource=${encodeURIComponent(ISSUER + '/mcp')}`;
  }

  function postAuthorize(clientId: string, challenge: string, workspace: string, password: string) {
    return app.inject({
      method: 'POST', url: '/oauth/authorize',
      payload: {
        password, workspace, client_id: clientId, redirect_uri: REDIRECT,
        code_challenge: challenge, code_challenge_method: 'S256', state: 's',
        resource: `${ISSUER}/mcp`,
      },
    });
  }

  it('GET form renders an editable workspace input prefilled with default', async () => {
    const clientId = await newClient();
    const { challenge } = pkce();
    const r = await app.inject({ method: 'GET', url: `/oauth/authorize${authQuery(clientId, challenge)}` });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/<input[^>]*type="text"[^>]*name="workspace"/);
    expect(r.body).toContain('value="agents"');
  });

  it('GET form prefills workspace from the ?workspace= query', async () => {
    const clientId = await newClient();
    const { challenge } = pkce();
    const r = await app.inject({
      method: 'GET',
      url: `/oauth/authorize${authQuery(clientId, challenge)}&workspace=romandots`,
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('value="romandots"');
  });

  it('authorizes a non-default tenant when its workspace + password are entered', async () => {
    store.registerTenant({
      workspace: 'romandots',
      plane_api_key: 'plane_api_romandots',
      auth_token_hash: createHash('sha256').update('tenant-pass-1').digest('hex'),
      created_at_ms: 1_700_000_000_000,
    });
    const clientId = await newClient();
    const { verifier, challenge } = pkce();
    const post = await postAuthorize(clientId, challenge, 'romandots', 'tenant-pass-1');
    expect(post.statusCode).toBe(302);
    const code = new URL(post.headers.location as string).searchParams.get('code') as string;

    const tok = await app.inject({
      method: 'POST', url: '/oauth/token',
      payload: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier },
    });
    expect(tok.statusCode).toBe(200);
    const access = JSON.parse(tok.body).access_token as string;
    const row = store.validateAccessToken(createHash('sha256').update(access).digest('hex'), 1_700_000_000_001);
    expect(row?.workspace).toBe('romandots');
  });

  it('rejects a wrong tenant password (re-renders form, 401)', async () => {
    store.registerTenant({
      workspace: 'romandots', plane_api_key: 'k',
      auth_token_hash: createHash('sha256').update('right-pass').digest('hex'),
      created_at_ms: 1,
    });
    const clientId = await newClient();
    const { challenge } = pkce();
    const post = await postAuthorize(clientId, challenge, 'romandots', 'wrong-pass');
    expect(post.statusCode).toBe(401);
    expect(post.body).toContain('Invalid password');
    // ввод сохраняется при ре-рендере + anti-clickjacking заголовки на месте.
    expect(post.body).toContain('value="romandots"');
    expect(post.headers['x-frame-options']).toBe('DENY');
  });

  it('rejects an unknown (non-default, no tenant) workspace', async () => {
    const clientId = await newClient();
    const { challenge } = pkce();
    const post = await postAuthorize(clientId, challenge, 'ghost', STATIC_TOKEN);
    expect(post.statusCode).toBe(400);
    expect(post.body).toContain('Unknown workspace');
    expect(post.body).toContain('value="ghost"');
    expect(post.headers['x-frame-options']).toBe('DENY');
  });

  it('rejects a malformed workspace slug at schema validation (no form re-render)', async () => {
    const clientId = await newClient();
    const { challenge } = pkce();
    // Пробел/спецсимволы (в т.ч. XSS-пейлоад) не проходят slug-regex → 400
    // invalid_request на уровне схемы, в renderLoginForm не попадают.
    const post = await postAuthorize(clientId, challenge, '<script>alert(1)</script>', STATIC_TOKEN);
    expect(post.statusCode).toBe(400);
    expect(post.body).not.toContain('<script>alert(1)</script>');
  });

  it('still authorizes the default workspace with MCP_AUTH_TOKEN (backward compat)', async () => {
    const clientId = await newClient();
    const { challenge } = pkce();
    const post = await postAuthorize(clientId, challenge, 'agents', STATIC_TOKEN);
    expect(post.statusCode).toBe(302);
  });
});
