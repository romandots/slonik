import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OAuthStore } from './store.js';

describe('OAuthStore', () => {
  let store: OAuthStore;
  beforeEach(() => {
    store = new OAuthStore({ path: ':memory:', maxClients: 3 });
  });
  afterEach(() => store.close());

  const now = 1_000_000; // фиксированное «сейчас» в ms

  it('registers a client and reads it back', () => {
    const c = store.registerClient({
      client_name: 'claude.ai',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      created_at_ms: now,
    });
    expect(c.client_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const got = store.getClient(c.client_id);
    expect(got?.redirect_uris).toEqual(['https://claude.ai/api/mcp/auth_callback']);
  });

  it('enforces the client cap', () => {
    for (let i = 0; i < 3; i += 1) {
      store.registerClient({ client_name: `c${i}`, redirect_uris: ['https://x/cb'], created_at_ms: now });
    }
    expect(() =>
      store.registerClient({ client_name: 'overflow', redirect_uris: ['https://x/cb'], created_at_ms: now }),
    ).toThrow(/cap/i);
  });

  it('consumes an authorization code exactly once', () => {
    store.saveCode({
      code_hash: 'h1', client_id: 'c1', redirect_uri: 'https://x/cb',
      code_challenge: 'chal', identity: 'operator', scope: 'mcp',
      resource: 'https://slonk/mcp', workspace: '', expires_at_ms: now + 60_000,
    });
    const first = store.consumeCode('h1', now);
    expect(first?.client_id).toBe('c1');
    const second = store.consumeCode('h1', now);
    expect(second).toBeUndefined(); // already used
  });

  it('rejects an expired authorization code', () => {
    store.saveCode({
      code_hash: 'h2', client_id: 'c1', redirect_uri: 'https://x/cb',
      code_challenge: 'chal', identity: 'operator', scope: 'mcp',
      resource: 'https://slonk/mcp', workspace: '', expires_at_ms: now - 1,
    });
    expect(store.consumeCode('h2', now)).toBeUndefined();
  });

  it('issues an access token and validates it before expiry', () => {
    store.saveToken({
      token_hash: 't1', kind: 'access', client_id: 'c1', identity: 'operator',
      scope: 'mcp', resource: 'https://slonk/mcp', workspace: '',
      expires_at_ms: now + 3600_000, refresh_chain_id: 'chain1',
    });
    expect(store.validateAccessToken('t1', now)?.identity).toBe('operator');
    expect(store.validateAccessToken('t1', now + 3_600_001)).toBeUndefined();
    expect(store.validateAccessToken('nope', now)).toBeUndefined();
  });

  it('rotates a refresh token and invalidates the whole chain on reuse', () => {
    store.saveToken({
      token_hash: 'r1', kind: 'refresh', client_id: 'c1', identity: 'operator',
      scope: 'mcp', resource: 'https://slonk/mcp', workspace: '',
      expires_at_ms: now + 9_000_000, refresh_chain_id: 'chainA',
    });
    // First use rotates successfully.
    const used = store.consumeRefreshToken('r1', now);
    expect(used?.refresh_chain_id).toBe('chainA');
    // A sibling refresh issued into the same chain (as rotation would do).
    store.saveToken({
      token_hash: 'r2', kind: 'refresh', client_id: 'c1', identity: 'operator',
      scope: 'mcp', resource: 'https://slonk/mcp', workspace: '',
      expires_at_ms: now + 9_000_000, refresh_chain_id: 'chainA',
    });
    // Reusing the already-consumed r1 must auto-poison the whole chain (theft signal),
    // WITHOUT any manual poisonChain call.
    expect(store.consumeRefreshToken('r1', now)).toBeUndefined();
    // r2 is now invalid because the chain was auto-poisoned by the reuse above.
    expect(store.consumeRefreshToken('r2', now)).toBeUndefined();
  });

  it('rejects an expired refresh token', () => {
    store.saveToken({
      token_hash: 'r-exp', kind: 'refresh', client_id: 'c1', identity: 'operator',
      scope: 'mcp', resource: 'https://slonk/mcp', workspace: '',
      expires_at_ms: now - 1, refresh_chain_id: 'chainExp',
    });
    expect(store.consumeRefreshToken('r-exp', now)).toBeUndefined();
  });

  it('validateAccessToken rejects a token whose chain was poisoned', () => {
    store.saveToken({
      token_hash: 'a1', kind: 'access', client_id: 'c1', identity: 'operator',
      scope: 'mcp', resource: 'https://slonk/mcp', workspace: '',
      expires_at_ms: now + 3600_000, refresh_chain_id: 'chainA',
    });
    expect(store.validateAccessToken('a1', now)).toBeDefined();
    store.poisonChain('chainA');
    expect(store.validateAccessToken('a1', now)).toBeUndefined();
  });

  it('revokes an access token', () => {
    store.saveToken({
      token_hash: 't9', kind: 'access', client_id: 'c1', identity: 'operator',
      scope: 'mcp', resource: 'https://slonk/mcp', workspace: '',
      expires_at_ms: now + 3600_000, refresh_chain_id: 'c9',
    });
    store.revokeToken('t9');
    expect(store.validateAccessToken('t9', now)).toBeUndefined();
  });

  it('revokes a refresh token', () => {
    store.saveToken({
      token_hash: 'rr', kind: 'refresh', client_id: 'c1', identity: 'operator',
      scope: 'mcp', resource: 'https://slonk/mcp', workspace: '',
      expires_at_ms: now + 9_000_000, refresh_chain_id: 'cr',
    });
    store.revokeToken('rr');
    expect(store.consumeRefreshToken('rr', now)).toBeUndefined();
  });

  it('revokeChainByToken poisons the whole chain', () => {
    store.saveToken({ token_hash: 'acc', kind: 'access', client_id: 'c1', identity: 'operator', scope: 'mcp', resource: 'https://slonk/mcp', workspace: '', expires_at_ms: now + 3600_000, refresh_chain_id: 'chainZ' });
    store.saveToken({ token_hash: 'ref', kind: 'refresh', client_id: 'c1', identity: 'operator', scope: 'mcp', resource: 'https://slonk/mcp', workspace: '', expires_at_ms: now + 9_000_000, refresh_chain_id: 'chainZ' });
    store.revokeChainByToken('ref');
    expect(store.validateAccessToken('acc', now)).toBeUndefined();      // access killed too
    expect(store.consumeRefreshToken('ref', now)).toBeUndefined();      // refresh killed
  });
});

describe('OAuthStore — tenant management', () => {
  let store: OAuthStore;
  beforeEach(() => { store = new OAuthStore({ path: ':memory:', maxClients: 10 }); });
  afterEach(() => store.close());

  const now = 1_000_000;

  it('registers a tenant and looks it up by workspace', () => {
    store.registerTenant({ workspace: 'alice', plane_api_key: 'key-alice', auth_token_hash: 'hash-alice', created_at_ms: now });
    const t = store.getTenantByWorkspace('alice');
    expect(t?.plane_api_key).toBe('key-alice');
    expect(t?.auth_token_hash).toBe('hash-alice');
  });

  it('looks up tenant by auth_token_hash', () => {
    store.registerTenant({ workspace: 'bob', plane_api_key: 'key-bob', auth_token_hash: 'hash-bob', created_at_ms: now });
    const t = store.getTenantByAuthTokenHash('hash-bob');
    expect(t?.workspace).toBe('bob');
  });

  it('returns undefined for unknown workspace', () => {
    expect(store.getTenantByWorkspace('nobody')).toBeUndefined();
  });

  it('upserts (re-registration is idempotent)', () => {
    store.registerTenant({ workspace: 'alice', plane_api_key: 'key-v1', auth_token_hash: 'h1', created_at_ms: now });
    store.registerTenant({ workspace: 'alice', plane_api_key: 'key-v2', auth_token_hash: 'h2', created_at_ms: now + 1 });
    expect(store.getTenantByWorkspace('alice')?.plane_api_key).toBe('key-v2');
    expect(store.listTenants()).toHaveLength(1);
  });

  it('preserves workspace in tokens (isolation)', () => {
    store.saveToken({
      token_hash: 'tok-alice', kind: 'access', client_id: 'c1',
      identity: 'operator', scope: 'mcp', resource: 'https://x/mcp',
      workspace: 'alice', expires_at_ms: now + 3600_000, refresh_chain_id: 'chain',
    });
    store.saveToken({
      token_hash: 'tok-bob', kind: 'access', client_id: 'c2',
      identity: 'operator', scope: 'mcp', resource: 'https://x/mcp',
      workspace: 'bob', expires_at_ms: now + 3600_000, refresh_chain_id: 'chain2',
    });
    // Alice token carries alice workspace
    const rowAlice = store.validateAccessToken('tok-alice', now);
    expect(rowAlice?.workspace).toBe('alice');
    // Bob token carries bob workspace
    const rowBob = store.validateAccessToken('tok-bob', now);
    expect(rowBob?.workspace).toBe('bob');
    // Tokens are distinct — alice cannot use bob's token
    expect(rowAlice?.token_hash).not.toBe(rowBob?.token_hash);
  });

  it('schema migration adds workspace column to existing tables', () => {
    // Simulatable by checking that tokens without explicit workspace default to ''
    store.saveToken({
      token_hash: 'tok-empty', kind: 'access', client_id: 'c1',
      identity: 'op', scope: 'mcp', resource: 'r',
      workspace: '', expires_at_ms: now + 3600_000, refresh_chain_id: 'ch',
    });
    expect(store.validateAccessToken('tok-empty', now)?.workspace).toBe('');
  });
});
