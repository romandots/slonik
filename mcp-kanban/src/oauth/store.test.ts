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
      resource: 'https://slonk/mcp', expires_at_ms: now + 60_000,
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
      resource: 'https://slonk/mcp', expires_at_ms: now - 1,
    });
    expect(store.consumeCode('h2', now)).toBeUndefined();
  });

  it('issues an access token and validates it before expiry', () => {
    store.saveToken({
      token_hash: 't1', kind: 'access', client_id: 'c1', identity: 'operator',
      scope: 'mcp', resource: 'https://slonk/mcp',
      expires_at_ms: now + 3600_000, refresh_chain_id: 'chain1',
    });
    expect(store.validateAccessToken('t1', now)?.identity).toBe('operator');
    expect(store.validateAccessToken('t1', now + 3_600_001)).toBeUndefined();
    expect(store.validateAccessToken('nope', now)).toBeUndefined();
  });

  it('rotates a refresh token and invalidates the whole chain on reuse', () => {
    store.saveToken({
      token_hash: 'r1', kind: 'refresh', client_id: 'c1', identity: 'operator',
      scope: 'mcp', resource: 'https://slonk/mcp',
      expires_at_ms: now + 9_000_000, refresh_chain_id: 'chainA',
    });
    // First use rotates successfully.
    const used = store.consumeRefreshToken('r1', now);
    expect(used?.refresh_chain_id).toBe('chainA');
    // A sibling refresh issued into the same chain (as rotation would do).
    store.saveToken({
      token_hash: 'r2', kind: 'refresh', client_id: 'c1', identity: 'operator',
      scope: 'mcp', resource: 'https://slonk/mcp',
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
      scope: 'mcp', resource: 'https://slonk/mcp',
      expires_at_ms: now - 1, refresh_chain_id: 'chainExp',
    });
    expect(store.consumeRefreshToken('r-exp', now)).toBeUndefined();
  });

  it('validateAccessToken rejects a token whose chain was poisoned', () => {
    store.saveToken({
      token_hash: 'a1', kind: 'access', client_id: 'c1', identity: 'operator',
      scope: 'mcp', resource: 'https://slonk/mcp',
      expires_at_ms: now + 3600_000, refresh_chain_id: 'chainA',
    });
    expect(store.validateAccessToken('a1', now)).toBeDefined();
    store.poisonChain('chainA');
    expect(store.validateAccessToken('a1', now)).toBeUndefined();
  });

  it('revokes an access token', () => {
    store.saveToken({
      token_hash: 't9', kind: 'access', client_id: 'c1', identity: 'operator',
      scope: 'mcp', resource: 'https://slonk/mcp',
      expires_at_ms: now + 3600_000, refresh_chain_id: 'c9',
    });
    store.revokeToken('t9');
    expect(store.validateAccessToken('t9', now)).toBeUndefined();
  });

  it('revokes a refresh token', () => {
    store.saveToken({
      token_hash: 'rr', kind: 'refresh', client_id: 'c1', identity: 'operator',
      scope: 'mcp', resource: 'https://slonk/mcp',
      expires_at_ms: now + 9_000_000, refresh_chain_id: 'cr',
    });
    store.revokeToken('rr');
    expect(store.consumeRefreshToken('rr', now)).toBeUndefined();
  });

  it('revokeChainByToken poisons the whole chain', () => {
    store.saveToken({ token_hash: 'acc', kind: 'access', client_id: 'c1', identity: 'operator', scope: 'mcp', resource: 'https://slonk/mcp', expires_at_ms: now + 3600_000, refresh_chain_id: 'chainZ' });
    store.saveToken({ token_hash: 'ref', kind: 'refresh', client_id: 'c1', identity: 'operator', scope: 'mcp', resource: 'https://slonk/mcp', expires_at_ms: now + 9_000_000, refresh_chain_id: 'chainZ' });
    store.revokeChainByToken('ref');
    expect(store.validateAccessToken('acc', now)).toBeUndefined();      // access killed too
    expect(store.consumeRefreshToken('ref', now)).toBeUndefined();      // refresh killed
  });
});
