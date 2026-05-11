import { describe, expect, it } from 'vitest';
import {
  parseDescription,
  serializeDescription,
  upsertGitRef,
  removeGitRef,
  MetaBlockMarker,
} from './meta-block.js';

const sample = `
Implement auth flow.

Some body text.

---
${MetaBlockMarker}
repos:
  - url: https://github.com/acme/backend
    branch: feature/SLONK-123-auth-flow
    pr: https://github.com/acme/backend/pull/456
    commits:
      - 4f1a2b3
      - 9c8d7e6f
`;

describe('parseDescription', () => {
  it('returns empty meta for empty input', () => {
    const r = parseDescription('');
    expect(r.body).toBe('');
    expect(r.meta.repos).toEqual([]);
    expect(r.corrupt).toBe(false);
  });

  it('treats description without marker as pure body', () => {
    const r = parseDescription('Just a description, no meta.');
    expect(r.body).toBe('Just a description, no meta.');
    expect(r.meta.repos).toEqual([]);
  });

  it('extracts body + repos', () => {
    const r = parseDescription(sample);
    expect(r.body).toContain('Some body text');
    expect(r.body).not.toContain('slonk:meta');
    expect(r.meta.repos).toHaveLength(1);
    expect(r.meta.repos[0]?.commits).toEqual(['4f1a2b3', '9c8d7e6f']);
    expect(r.corrupt).toBe(false);
  });

  it('flags corrupt when commit sha is bad', () => {
    const broken = `
body
---
${MetaBlockMarker}
repos:
  - url: https://example.com/x
    commits: [ "NOT_A_HEX_SHA" ]
`;
    const r = parseDescription(broken);
    expect(r.corrupt).toBe(true);
    expect(r.error).toMatch(/commit/i);
    expect(r.meta.repos).toEqual([]);
  });

  it('flags corrupt when YAML is malformed', () => {
    const broken = `
body
---
${MetaBlockMarker}
repos: : : not yaml
`;
    const r = parseDescription(broken);
    expect(r.corrupt).toBe(true);
  });
});

describe('serializeDescription', () => {
  it('round-trips body + meta', () => {
    const parsed = parseDescription(sample);
    const round = serializeDescription(parsed.body, parsed.meta);
    const reparsed = parseDescription(round);
    expect(reparsed.body).toBe(parsed.body);
    expect(reparsed.meta).toEqual(parsed.meta);
  });

  it('omits the block when meta is empty', () => {
    const out = serializeDescription('hello', { repos: [] });
    expect(out).toBe('hello');
  });
});

describe('upsertGitRef / removeGitRef', () => {
  it('upsert is idempotent by url+commit', () => {
    let meta = { repos: [] as never[] };
    meta = upsertGitRef(meta, {
      url: 'https://github.com/acme/backend',
      branch: 'feature/x',
      commits: ['abcdef1'],
    });
    meta = upsertGitRef(meta, {
      url: 'https://github.com/acme/backend',
      branch: 'feature/x',
      commits: ['abcdef1'],
    });
    expect(meta.repos).toHaveLength(1);
    expect(meta.repos[0]?.commits).toEqual(['abcdef1']);
  });

  it('upsert merges commits and adds pr_url', () => {
    let meta = { repos: [] as never[] };
    meta = upsertGitRef(meta, {
      url: 'https://github.com/acme/backend',
      branch: 'feature/x',
      commits: ['aaaaaaa'],
    });
    meta = upsertGitRef(meta, {
      url: 'https://github.com/acme/backend',
      pr: 'https://github.com/acme/backend/pull/1',
      commits: ['bbbbbbb'],
    });
    expect(meta.repos).toHaveLength(1);
    expect(meta.repos[0]?.commits).toEqual(['aaaaaaa', 'bbbbbbb']);
    expect(meta.repos[0]?.pr).toBe('https://github.com/acme/backend/pull/1');
    expect(meta.repos[0]?.branch).toBe('feature/x');
  });

  it('remove drops by url+commit', () => {
    let meta = { repos: [] as never[] };
    meta = upsertGitRef(meta, {
      url: 'https://github.com/acme/backend',
      commits: ['aaaaaaa', 'bbbbbbb'],
      branch: 'b',
    });
    meta = removeGitRef(meta, { url: 'https://github.com/acme/backend', commit: 'aaaaaaa' });
    expect(meta.repos[0]?.commits).toEqual(['bbbbbbb']);
  });

  it('remove without commit drops the whole entry', () => {
    let meta = { repos: [] as never[] };
    meta = upsertGitRef(meta, {
      url: 'https://github.com/acme/backend',
      commits: ['aaaaaaa'],
    });
    meta = removeGitRef(meta, { url: 'https://github.com/acme/backend' });
    expect(meta.repos).toHaveLength(0);
  });
});
