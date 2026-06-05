import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  generateOpaqueToken,
  hashToken,
  verifyPkceS256,
  base64UrlSha256,
  constantTimeEqual,
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
    // Pinned vector: catches accidental algorithm/encoding drift.
    expect(hashToken('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('constantTimeEqual is false for different lengths (no throw) and true for identical', () => {
    expect(constantTimeEqual('short', 'different-length')).toBe(false);
    expect(constantTimeEqual('', 'nonempty')).toBe(false);
    expect(constantTimeEqual('same', 'same')).toBe(true);
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
