import { describe, expect, it } from 'vitest';
import { parseBootstrapArgs } from './cli.js';

// SLONK-18: разбор multitenant-флагов bootstrap + защита от path-traversal slug.
describe('parseBootstrapArgs', () => {
  it('returns empty overrides for no flags (backward compat)', () => {
    expect(parseBootstrapArgs([])).toEqual({});
  });

  it('strips a leading "bootstrap" token', () => {
    const r = parseBootstrapArgs(['bootstrap', '--workspace', 'acme']);
    expect(r.workspaceSlug).toBe('acme');
  });

  it('parses --workspace and --plane-api-key', () => {
    const r = parseBootstrapArgs(['--workspace', 'team-1', '--plane-api-key', 'plane_api_x']);
    expect(r).toEqual({ workspaceSlug: 'team-1', planeApiKey: 'plane_api_x' });
  });

  it('rejects a traversal-style workspace slug', () => {
    expect(() => parseBootstrapArgs(['--workspace', '../../etc/passwd'])).toThrow(/Invalid workspace slug/);
  });

  it('rejects an uppercase / spaced slug', () => {
    expect(() => parseBootstrapArgs(['--workspace', 'Acme Corp'])).toThrow(/Invalid workspace slug/);
  });

  it('rejects a leading/trailing dash slug', () => {
    expect(() => parseBootstrapArgs(['--workspace', '-acme'])).toThrow(/Invalid workspace slug/);
    expect(() => parseBootstrapArgs(['--workspace', 'acme-'])).toThrow(/Invalid workspace slug/);
  });

  it('rejects an empty flag value', () => {
    expect(() => parseBootstrapArgs(['--workspace', ''])).toThrow(/non-empty value/);
    expect(() => parseBootstrapArgs(['--plane-api-key', ''])).toThrow(/non-empty value/);
  });

  it('rejects unknown arguments', () => {
    expect(() => parseBootstrapArgs(['--bogus', 'x'])).toThrow(/Unknown argument/);
  });
});
