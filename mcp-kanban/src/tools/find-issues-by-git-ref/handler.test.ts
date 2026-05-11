import { describe, expect, it } from 'vitest';
import { findIssuesByGitRef } from './handler.js';
import { GitRefsIndex } from '../../git-refs.js';

const REPO = 'https://github.com/acme/backend';

describe('findIssuesByGitRef', () => {
  it('finds by commit_sha', () => {
    const gitRefs = new GitRefsIndex({ path: ':memory:' });
    gitRefs.upsert({
      workspace: 'agents',
      project_identifier: 'SLONK',
      issue_id: 'iss-1',
      issue_key: 'SLONK-1',
      repo_url: REPO,
      branch: 'feature/x',
      commit_sha: 'abcdef1',
    });

    const r = findIssuesByGitRef({
      gitRefs,
      input: { commit: 'abcdef1' },
    });

    expect(r.count).toBe(1);
    expect(r.results[0]?.issue_key).toBe('SLONK-1');
    gitRefs.close();
  });

  it('finds by branch + repo intersection', () => {
    const gitRefs = new GitRefsIndex({ path: ':memory:' });
    gitRefs.upsert({
      workspace: 'agents',
      project_identifier: 'SLONK',
      issue_id: 'iss-1',
      issue_key: 'SLONK-1',
      repo_url: REPO,
      branch: 'feature/SLONK-1',
    });
    gitRefs.upsert({
      workspace: 'agents',
      project_identifier: 'SLONK',
      issue_id: 'iss-2',
      issue_key: 'SLONK-2',
      repo_url: 'https://github.com/acme/other',
      branch: 'feature/SLONK-1',
    });

    const r = findIssuesByGitRef({
      gitRefs,
      input: { repo_url: REPO, branch: 'feature/SLONK-1' },
    });

    expect(r.count).toBe(1);
    expect(r.results[0]?.issue_key).toBe('SLONK-1');
    gitRefs.close();
  });

  it('rejects empty input via schema', async () => {
    const { FindIssuesByGitRefInput } = await import('./schema.js');
    expect(() => FindIssuesByGitRefInput.parse({})).toThrow();
  });

  it('returns commit_sha=null for sentinel rows', () => {
    const gitRefs = new GitRefsIndex({ path: ':memory:' });
    gitRefs.upsert({
      workspace: 'agents',
      project_identifier: 'SLONK',
      issue_id: 'iss-1',
      issue_key: 'SLONK-1',
      repo_url: REPO,
      branch: 'feature/SLONK-1',
    });
    const r = findIssuesByGitRef({ gitRefs, input: { repo_url: REPO } });
    expect(r.results[0]?.commit_sha).toBeNull();
    gitRefs.close();
  });
});
