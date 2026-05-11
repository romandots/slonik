import { describe, expect, it } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { authenticate, type AuthedRequest } from './auth.js';
import { McpError } from './errors.js';

const TOKEN = 'a'.repeat(64);

function fakeRequest(headers: Record<string, string | undefined>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}
const fakeReply = {} as FastifyReply;

describe('authenticate', () => {
  it('throws UNAUTHORIZED when Authorization header missing', () => {
    const err = expectThrows(() =>
      authenticate(fakeRequest({}), fakeReply, { expectedToken: TOKEN }),
    );
    expect(err.code).toBe('UNAUTHORIZED');
  });

  it('throws UNAUTHORIZED when scheme not Bearer', () => {
    const err = expectThrows(() =>
      authenticate(fakeRequest({ authorization: `Basic ${TOKEN}` }), fakeReply, {
        expectedToken: TOKEN,
      }),
    );
    expect(err.code).toBe('UNAUTHORIZED');
  });

  it('throws UNAUTHORIZED when token mismatches', () => {
    const err = expectThrows(() =>
      authenticate(fakeRequest({ authorization: `Bearer ${'b'.repeat(64)}` }), fakeReply, {
        expectedToken: TOKEN,
      }),
    );
    expect(err.code).toBe('UNAUTHORIZED');
  });

  it('throws IDENTITY_REQUIRED when X-Agent-Identity is missing', () => {
    const err = expectThrows(() =>
      authenticate(fakeRequest({ authorization: `Bearer ${TOKEN}` }), fakeReply, {
        expectedToken: TOKEN,
      }),
    );
    expect(err.code).toBe('IDENTITY_REQUIRED');
  });

  it('throws IDENTITY_REQUIRED for unknown identity', () => {
    const err = expectThrows(() =>
      authenticate(
        fakeRequest({ authorization: `Bearer ${TOKEN}`, 'x-agent-identity': 'mystery-agent' }),
        fakeReply,
        { expectedToken: TOKEN },
      ),
    );
    expect(err.code).toBe('IDENTITY_REQUIRED');
  });

  it('passes for valid bearer + known identity, mutating request', () => {
    const req = fakeRequest({
      authorization: `Bearer ${TOKEN}`,
      'x-agent-identity': 'developer-agent',
    });
    authenticate(req, fakeReply, { expectedToken: TOKEN });
    expect((req as AuthedRequest).identity).toBe('developer-agent');
  });

  it('passes for valid bearer without identity when requireIdentity=false', () => {
    const req = fakeRequest({ authorization: `Bearer ${TOKEN}` });
    expect(() =>
      authenticate(req, fakeReply, { expectedToken: TOKEN, requireIdentity: false }),
    ).not.toThrow();
    expect((req as Partial<AuthedRequest>).identity).toBeUndefined();
  });
});

function expectThrows(fn: () => void): McpError {
  try {
    fn();
  } catch (e) {
    if (e instanceof McpError) return e;
    throw e;
  }
  throw new Error('expected function to throw');
}
