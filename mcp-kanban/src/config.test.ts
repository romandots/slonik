import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const validBase = {
  MCP_AUTH_TOKEN: 'a'.repeat(64),
  PLANE_API_BASE_URL: 'http://plane-api:8000/api/v1',
};

describe('loadConfig', () => {
  it('accepts a minimal valid env', () => {
    const cfg = loadConfig(validBase);
    expect(cfg.MCP_SERVER_PORT).toBe(8787);
    expect(cfg.MCP_AGENT_IDENTITY_MODE).toBe('per_user');
    expect(cfg.MCP_ALLOWED_PROJECTS).toEqual(['SLONK']);
  });

  it('rejects change_me as MCP_AUTH_TOKEN', () => {
    expect(() => loadConfig({ ...validBase, MCP_AUTH_TOKEN: 'change_me' })).toThrow(
      /must be replaced/,
    );
  });

  it('rejects a short MCP_AUTH_TOKEN', () => {
    expect(() => loadConfig({ ...validBase, MCP_AUTH_TOKEN: 'short' })).toThrow(
      /at least 32 chars/,
    );
  });

  it('parses CSV MCP_ALLOWED_PROJECTS', () => {
    const cfg = loadConfig({ ...validBase, MCP_ALLOWED_PROJECTS: 'p1, p2 ,p3 ' });
    expect(cfg.MCP_ALLOWED_PROJECTS).toEqual(['p1', 'p2', 'p3']);
  });

  it('coerces Bool01 from various string forms', () => {
    expect(loadConfig({ ...validBase, MCP_METRICS_ENABLED: '1' }).MCP_METRICS_ENABLED).toBe(true);
    expect(loadConfig({ ...validBase, MCP_METRICS_ENABLED: 'true' }).MCP_METRICS_ENABLED).toBe(true);
    expect(loadConfig({ ...validBase, MCP_METRICS_ENABLED: '0' }).MCP_METRICS_ENABLED).toBe(false);
    expect(loadConfig({ ...validBase, MCP_METRICS_ENABLED: 'false' }).MCP_METRICS_ENABLED).toBe(false);
  });

  it('rejects invalid agent identity mode', () => {
    expect(() =>
      loadConfig({ ...validBase, MCP_AGENT_IDENTITY_MODE: 'bot_swarm' }),
    ).toThrow(/MCP_AGENT_IDENTITY_MODE/);
  });
});
