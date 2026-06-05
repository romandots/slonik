import { describe, expect, it } from 'vitest';
import {
  buildProtectedResourceMetadata,
  buildAuthorizationServerMetadata,
} from './metadata.js';

const ISSUER = 'https://slonk.example.com';

describe('oauth metadata', () => {
  it('protected resource metadata points at the AS and the /mcp resource', () => {
    const m = buildProtectedResourceMetadata(ISSUER);
    expect(m.resource).toBe('https://slonk.example.com/mcp');
    expect(m.authorization_servers).toEqual([ISSUER]);
    expect(m.bearer_methods_supported).toContain('header');
  });

  it('authorization server metadata advertises PKCE S256 and the right endpoints', () => {
    const m = buildAuthorizationServerMetadata(ISSUER);
    expect(m.issuer).toBe(ISSUER);
    expect(m.authorization_endpoint).toBe('https://slonk.example.com/oauth/authorize');
    expect(m.token_endpoint).toBe('https://slonk.example.com/oauth/token');
    expect(m.registration_endpoint).toBe('https://slonk.example.com/oauth/register');
    expect(m.code_challenge_methods_supported).toEqual(['S256']);
    expect(m.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(m.response_types_supported).toEqual(['code']);
    expect(m.token_endpoint_auth_methods_supported).toContain('none');
  });

  it('trims a trailing slash on the issuer', () => {
    const m = buildAuthorizationServerMetadata('https://slonk.example.com/');
    expect(m.issuer).toBe('https://slonk.example.com');
    expect(m.token_endpoint).toBe('https://slonk.example.com/oauth/token');
  });
});
