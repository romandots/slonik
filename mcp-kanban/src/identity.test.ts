import { describe, expect, it } from 'vitest';
import {
  createIdentityRegistry,
  createIdentityRegistryFromManifest,
  createIdentityRegistryFromStore,
} from './identity.js';
import type { Manifest } from './bootstrap/manifest.js';
import { IdentityStore } from './bootstrap/store.js';

function fakeManifest(roles: string[]): Manifest {
  return {
    workspace: { slug: 'agents', name: 'Code Agents' },
    projects: [
      {
        slug: 'p',
        name: 'P',
        identifier: 'P',
        modules: [],
      },
    ],
    states: [
      { name: 'Backlog', group: 'backlog', color: '#94a3b8', order: 1, default: true },
    ],
    labels: [{ name: 'agent-ready', color: '#3b82f6' }],
    identities: roles.map((role, i) => ({
      role,
      email: `${role}@example.com`,
      first_name: `F${i}`,
      last_name: 'L',
      default_state: 'Backlog',
    })),
  };
}

describe('createIdentityRegistry', () => {
  it('rejects unknown identities and accepts known ones', () => {
    const r = createIdentityRegistry(['developer-agent', 'merger-agent']);
    expect(r.has('developer-agent')).toBe(true);
    expect(r.has('merger-agent')).toBe(true);
    expect(r.has('mystery-agent')).toBe(false);
    expect(r.has('')).toBe(false);
  });

  it('returns sorted snapshot via list()', () => {
    const r = createIdentityRegistry(['zeta', 'alpha', 'mike']);
    expect(r.list()).toEqual(['alpha', 'mike', 'zeta']);
  });

  it('deduplicates and ignores empty strings', () => {
    const r = createIdentityRegistry(['x', 'x', '', 'y']);
    expect(r.size).toBe(2);
    expect(r.list()).toEqual(['x', 'y']);
  });

  it('empty input → empty registry, rejects everything', () => {
    const r = createIdentityRegistry([]);
    expect(r.size).toBe(0);
    expect(r.has('developer-agent')).toBe(false);
    expect(r.list()).toEqual([]);
  });
});

describe('createIdentityRegistryFromManifest', () => {
  it('takes roles from manifest.identities', () => {
    const r = createIdentityRegistryFromManifest(
      fakeManifest(['analyst-agent', 'developer-agent', 'merger-agent']),
    );
    expect(r.has('analyst-agent')).toBe(true);
    expect(r.has('merger-agent')).toBe(true);
    expect(r.has('unknown-agent')).toBe(false);
    expect(r.size).toBe(3);
  });

  it('handles manifest with empty identities array', () => {
    const r = createIdentityRegistryFromManifest(fakeManifest([]));
    expect(r.size).toBe(0);
    expect(r.has('developer-agent')).toBe(false);
  });
});

describe('createIdentityRegistryFromStore', () => {
  it('takes roles from IdentityStore.all()', () => {
    const store = new IdentityStore({ path: ':memory:' });
    for (const role of ['developer-agent', 'qa-agent', 'merger-agent']) {
      store.upsert({
        role,
        email: `${role}@slonk.local`,
        plane_user_id: null,
        mode: 'per_user',
        default_state: 'Backlog',
        state_aliases: [],
      });
    }
    const r = createIdentityRegistryFromStore(store);
    expect(r.has('developer-agent')).toBe(true);
    expect(r.has('merger-agent')).toBe(true);
    expect(r.has('analyst-agent')).toBe(false);
    expect(r.size).toBe(3);
    store.close();
  });

  it('empty store → empty registry', () => {
    const store = new IdentityStore({ path: ':memory:' });
    const r = createIdentityRegistryFromStore(store);
    expect(r.size).toBe(0);
    store.close();
  });
});
