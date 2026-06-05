import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  generateOpaqueToken,
  hashToken,
  verifyPkceS256,
  base64UrlSha256,
} from './crypto.js';

describe('oauth crypto', () => {
  it('generateOpaqueToken returns a 43-char base64url string, unique each call', () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('hashToken is deterministic sha256 hex', () => {
    expect(hashToken('hello')).toBe(createHash('sha256').update('hello').digest('hex'));
  });

  it('base64UrlSha256 matches the PKCE reference encoding', () => {
    const verifier = randomBytes(32).toString('base64url');
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(base64UrlSha256(verifier)).toBe(expected);
  });

  it('verifyPkceS256 accepts a matching verifier and rejects a wrong one', () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
    expect(verifyPkceS256('wrong-verifier', challenge)).toBe(false);
  });
});
