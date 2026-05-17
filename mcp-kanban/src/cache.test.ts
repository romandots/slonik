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

  // SLONK-5: без cap'а Map росла бесконечно при уникальных ключах
  // (типичный сценарий — `get_issue` с разными issue-ref'ами в окне TTL).
  it('enforces maxEntries cap with FIFO eviction', () => {
    const c = new TtlCache<number>({ ttlMs: 10_000, maxEntries: 3, gcEvery: 0 });
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    expect(c.size()).toBe(3);
    // 4-й ключ выкидывает 'a' (самый старый по insertion order).
    c.set('d', 4);
    expect(c.size()).toBe(3);
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe(2);
    expect(c.get('c')).toBe(3);
    expect(c.get('d')).toBe(4);
    expect(c.evictionStats().cap).toBe(1);
  });

  // Под нагрузкой (>>maxEntries уникальных ключей в окне TTL) cap должен
  // удерживать размер константным, а evictionStats.cap расти.
  it('keeps size bounded under burst of unique keys', () => {
    const cap = 16;
    const c = new TtlCache<number>({ ttlMs: 10_000, maxEntries: cap, gcEvery: 0 });
    for (let i = 0; i < cap * 5; i += 1) {
      c.set(`k${i}`, i);
    }
    expect(c.size()).toBe(cap);
    expect(c.evictionStats().cap).toBe(cap * 4);
  });

  // Updating an existing key не считается eviction'ом и не двигает FIFO-позицию.
  it('updating an existing key does not trigger eviction', () => {
    const c = new TtlCache<number>({ ttlMs: 10_000, maxEntries: 2, gcEvery: 0 });
    c.set('a', 1);
    c.set('b', 2);
    c.set('a', 11); // upsert, размер остаётся 2
    expect(c.size()).toBe(2);
    expect(c.evictionStats().cap).toBe(0);
    expect(c.get('a')).toBe(11);
    expect(c.get('b')).toBe(2);
  });

  // sweepExpired() удаляет все истёкшие ключи разом (используется janitor'ом
  // на set() и доступно для теста). Это закрывает дыру старого кода, где
  // истёкшие ключи лежали в Map'е до следующего get() по тому же ключу.
  it('sweepExpired removes all expired entries', () => {
    let now = 1000;
    const c = new TtlCache<number>({ ttlMs: 100, now: () => now, gcEvery: 0 });
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    now += 50;
    c.set('d', 4); // эта ещё жива
    now += 80;
    // 'a','b','c' истекли (130 > 100), 'd' ещё жива (80 < 100).
    expect(c.sweepExpired()).toBe(3);
    expect(c.size()).toBe(1);
    expect(c.get('d')).toBe(4);
    expect(c.evictionStats().ttl).toBe(3);
  });

  // Авто-sweep при каждом gcEvery-том set() — без этого бесконечный поток
  // редких уникальных ключей разрастал бы Map до cap'а даже на низком RPS.
  it('auto-sweeps expired entries every gcEvery sets', () => {
    let now = 1000;
    const c = new TtlCache<number>({ ttlMs: 100, now: () => now, gcEvery: 5 });
    c.set('a', 1);
    now += 200; // 'a' истекает
    // первые 4 set'а не триггерят sweep
    for (let i = 0; i < 3; i += 1) {
      c.set(`k${i}`, i);
    }
    expect(c.size()).toBe(4); // 'a' (истёкшая) + 3 свежих
    // 5-й set триггерит sweep — 'a' уходит, остаётся 4 свежих ('k0..k2','k3').
    c.set('k3', 3);
    expect(c.size()).toBe(4);
    expect(c.get('a')).toBeUndefined();
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
