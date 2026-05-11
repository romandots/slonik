import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer, type BuiltServer } from './server.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const TEST_TOKEN = 'a'.repeat(64); // ≥ 32 байт, не 'change_me' — проходит config

function testEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MCP_AUTH_TOKEN: TEST_TOKEN,
    PLANE_API_BASE_URL: 'http://plane-stub.invalid/api/v1',
    NODE_ENV: 'test',
    MCP_LOG_LEVEL: 'fatal',
    ...overrides,
  };
}

describe('mcp-kanban HTTP server', () => {
  let built: BuiltServer;

  beforeAll(async () => {
    const config = loadConfig(testEnv());
    const logger = createLogger(config);
    built = await buildServer({ config, logger });
    await built.app.ready();
  });

  afterAll(async () => {
    await built.close();
  });

  describe('/health', () => {
    it('responds 200 without auth', async () => {
      const r = await built.app.inject({ method: 'GET', url: '/health' });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.body) as Record<string, unknown>;
      expect(body['status']).toBe('ok');
      expect(body['service']).toBe('mcp-kanban');
      expect(body).toHaveProperty('plane_reachable');
      expect(body).toHaveProperty('version');
    });

    it('reports plane_reachable=false when Plane host is unreachable', async () => {
      const r = await built.app.inject({ method: 'GET', url: '/health' });
      const body = JSON.parse(r.body) as { plane_reachable: boolean };
      // plane-stub.invalid не резолвится → ожидаем false.
      expect(body.plane_reachable).toBe(false);
    });
  });

  describe('/mcp/tools', () => {
    it('returns 401 without Authorization header', async () => {
      const r = await built.app.inject({ method: 'GET', url: '/mcp/tools' });
      expect(r.statusCode).toBe(401);
      const body = JSON.parse(r.body) as { error: { code: string } };
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 with wrong bearer token', async () => {
      const r = await built.app.inject({
        method: 'GET',
        url: '/mcp/tools',
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(r.statusCode).toBe(401);
    });

    it('returns 401 with malformed Authorization (no Bearer prefix)', async () => {
      const r = await built.app.inject({
        method: 'GET',
        url: '/mcp/tools',
        headers: { authorization: TEST_TOKEN },
      });
      expect(r.statusCode).toBe(401);
    });

    it('returns tools list with valid bearer (no identity required)', async () => {
      const r = await built.app.inject({
        method: 'GET',
        url: '/mcp/tools',
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.body) as { tools: string[] };
      expect(body.tools).toContain('who_am_i');
    });
  });

  describe('/mcp (auth + identity)', () => {
    it('returns 401 without bearer', async () => {
      const r = await built.app.inject({
        method: 'POST',
        url: '/mcp',
        payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      });
      expect(r.statusCode).toBe(401);
    });

    it('returns 400 with valid bearer but missing X-Agent-Identity', async () => {
      const r = await built.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          'content-type': 'application/json',
        },
        payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      });
      expect(r.statusCode).toBe(400);
      const body = JSON.parse(r.body) as { error: { code: string } };
      expect(body.error.code).toBe('IDENTITY_REQUIRED');
    });

    it('returns IDENTITY_REQUIRED with unknown agent role', async () => {
      const r = await built.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          'x-agent-identity': 'invader-agent',
          'content-type': 'application/json',
        },
        payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      });
      expect(r.statusCode).toBe(400);
      const body = JSON.parse(r.body) as { error: { code: string } };
      expect(body.error.code).toBe('IDENTITY_REQUIRED');
    });
  });
});
