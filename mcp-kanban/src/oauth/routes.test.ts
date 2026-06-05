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
});
