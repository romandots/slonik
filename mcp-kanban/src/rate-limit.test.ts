import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limit.js';
import { McpError } from './errors.js';

describe('RateLimiter', () => {
  it('consumes tokens from global and identity buckets', () => {
    let now = 0;
    const rl = new RateLimiter({ globalRps: 5, identityRps: 2, now: () => now });
    rl.consume('developer-agent');
    expect(rl.identityTokens('developer-agent')).toBeCloseTo(1);
    expect(rl.globalTokens()).toBeCloseTo(4);
  });

  it('throws RATE_LIMITED when identity bucket runs out', () => {
    let now = 0;
    const rl = new RateLimiter({ globalRps: 100, identityRps: 2, now: () => now });
    rl.consume('developer-agent');
    rl.consume('developer-agent');
    expect(() => rl.consume('developer-agent')).toThrowError(McpError);
    try {
      rl.consume('developer-agent');
    } catch (err) {
      expect((err as McpError).code).toBe('RATE_LIMITED');
      expect((err as Error).message).toMatch(/retry_after_ms=/);
    }
  });

  it('refills over time', () => {
    let now = 0;
    const rl = new RateLimiter({ globalRps: 100, identityRps: 2, now: () => now });
    rl.consume('qa-agent');
    rl.consume('qa-agent');
    expect(() => rl.consume('qa-agent')).toThrow();
    now += 500; // 500ms → 1 token при 2 rps
    rl.consume('qa-agent');
    expect(() => rl.consume('qa-agent')).toThrow();
  });

  it('global bucket can block even when identity has tokens', () => {
    let now = 0;
    const rl = new RateLimiter({ globalRps: 1, identityRps: 1000, now: () => now });
    rl.consume('developer-agent');
    expect(() => rl.consume('qa-agent')).toThrowError(/global rate limit/);
  });
});
