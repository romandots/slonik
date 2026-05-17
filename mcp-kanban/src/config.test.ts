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

  // SLONK-11: путь до identity SQLite — опциональный ENV, тип
  // `optionalNonEmpty`. Пустая строка эквивалентна «не задано», непустая
  // принимается как есть; loader не подставляет дефолт (его держит
  // bootstrapCli / smoke-скрипт через BOOTSTRAP_STORE_DEFAULT_PATH).
  describe('MCP_IDENTITY_STORE_PATH', () => {
    it('defaults to undefined when not provided', () => {
      const cfg = loadConfig(validBase);
      expect(cfg.MCP_IDENTITY_STORE_PATH).toBeUndefined();
    });

    it('coerces empty string to undefined (compose ${VAR:-} pattern)', () => {
      const cfg = loadConfig({ ...validBase, MCP_IDENTITY_STORE_PATH: '' });
      expect(cfg.MCP_IDENTITY_STORE_PATH).toBeUndefined();
    });

    it('accepts a custom host path', () => {
      const cfg = loadConfig({
        ...validBase,
        MCP_IDENTITY_STORE_PATH: '/Users/op/slonk/mcp_data/identity.sqlite',
      });
      expect(cfg.MCP_IDENTITY_STORE_PATH).toBe(
        '/Users/op/slonk/mcp_data/identity.sqlite',
      );
    });
  });
});
