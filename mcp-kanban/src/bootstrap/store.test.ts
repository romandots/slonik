import { describe, expect, it } from 'vitest';
import { IdentityStore } from './store.js';

describe('IdentityStore', () => {
  it('upsert + get round-trip', () => {
    const store = new IdentityStore({ path: ':memory:' });
    store.upsert({
      role: 'developer-agent',
      email: 'developer-agent@slonk.local',
      plane_user_id: 'usr-1',
      mode: 'per_user',
    });
    const m = store.get('developer-agent');
    expect(m?.plane_user_id).toBe('usr-1');
    expect(m?.mode).toBe('per_user');
    expect(m?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    store.close();
  });

  it('upsert overwrites existing row', () => {
    const store = new IdentityStore({ path: ':memory:' });
    store.upsert({
      role: 'qa-agent',
      email: 'qa@slonk.local',
      plane_user_id: 'old',
      mode: 'per_user',
    });
    store.upsert({
      role: 'qa-agent',
      email: 'qa@slonk.local',
      plane_user_id: null,
      mode: 'single_bot',
    });
    const m = store.get('qa-agent');
    expect(m?.mode).toBe('single_bot');
    expect(m?.plane_user_id).toBeNull();
    store.close();
  });

  it('all() returns rows sorted by role', () => {
    const store = new IdentityStore({ path: ':memory:' });
    store.upsert({ role: 'z-agent', email: 'z@x', plane_user_id: null, mode: 'per_user' });
    store.upsert({ role: 'a-agent', email: 'a@x', plane_user_id: null, mode: 'per_user' });
    const rows = store.all();
    expect(rows.map((r) => r.role)).toEqual(['a-agent', 'z-agent']);
    store.close();
  });

  it('bootstrap_meta key/value', () => {
    const store = new IdentityStore({ path: ':memory:' });
    expect(store.getMeta('identity_mode')).toBeUndefined();
    store.setMeta('identity_mode', 'per_user');
    expect(store.getMeta('identity_mode')).toBe('per_user');
    store.setMeta('identity_mode', 'single_bot');
    expect(store.getMeta('identity_mode')).toBe('single_bot');
    store.close();
  });
});
