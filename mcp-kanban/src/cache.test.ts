import { describe, expect, it } from 'vitest';
import { TtlCache, inputHash } from './cache.js';

describe('TtlCache', () => {
  it('stores and returns values within ttl', () => {
    let now = 1000;
    const c = new TtlCache<number>({ ttlMs: 100, now: () => now });
    c.set('a', 42);
    expect(c.get('a')).toBe(42);
    now += 50;
    expect(c.get('a')).toBe(42);
  });

  it('expires after ttl', () => {
    let now = 1000;
    const c = new TtlCache<number>({ ttlMs: 100, now: () => now });
    c.set('a', 42);
    now += 200;
    expect(c.get('a')).toBeUndefined();
    expect(c.size()).toBe(0); // эвикция при чтении
  });

  it('memoize calls fn once within ttl', async () => {
    let now = 1000;
    let calls = 0;
    const c = new TtlCache<number>({ ttlMs: 100, now: () => now });
    const fn = async (): Promise<number> => {
      calls += 1;
      return 7;
    };
    expect(await c.memoize('k', fn)).toBe(7);
    expect(await c.memoize('k', fn)).toBe(7);
    expect(calls).toBe(1);
    now += 200;
    expect(await c.memoize('k', fn)).toBe(7);
    expect(calls).toBe(2);
  });

  it('clear removes all entries', () => {
    const c = new TtlCache<number>({ ttlMs: 100 });
    c.set('a', 1);
    c.set('b', 2);
    c.clear();
    expect(c.size()).toBe(0);
  });
});

describe('inputHash', () => {
  it('is stable across key order', () => {
    const a = inputHash({ tool: 'list_issues', state: 'To Do', label: 'bug' });
    const b = inputHash({ label: 'bug', tool: 'list_issues', state: 'To Do' });
    expect(a).toBe(b);
  });

  it('differs for different inputs', () => {
    const a = inputHash({ tool: 'list_issues', state: 'To Do' });
    const b = inputHash({ tool: 'list_issues', state: 'Done' });
    expect(a).not.toBe(b);
  });
});
