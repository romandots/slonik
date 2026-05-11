import { describe, expect, it } from 'vitest';
import { GitRefsIndex, rowToPublic } from './git-refs.js';

function freshIndex(): GitRefsIndex {
  return new GitRefsIndex({ path: ':memory:' });
}

const baseArgs = {
  workspace: 'agents',
  project_identifier: 'SLONK',
  issue_id: 'iss-1',
  issue_key: 'SLONK-1',
  repo_url: 'https://github.com/acme/backend',
};

describe('GitRefsIndex', () => {
  it('upsert is idempotent on (issue, repo, commit)', () => {
    const idx = freshIndex();
    idx.upsert({ ...baseArgs, branch: 'feature/x', commit_sha: 'abcdef1' });
    idx.upsert({ ...baseArgs, branch: 'feature/x', commit_sha: 'abcdef1' });
    const rows = idx.find({ commit_sha: 'abcdef1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.branch).toBe('feature/x');
    idx.close();
  });

  it('treats commit-less entries as single row per (issue, repo)', () => {
    const idx = freshIndex();
    idx.upsert({ ...baseArgs, branch: 'feature/x' });
    idx.upsert({ ...baseArgs, branch: 'feature/x', pr_url: 'https://github.com/acme/backend/pull/1' });
    const rows = idx.find({ repo_url: baseArgs.repo_url });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pr_url).toBe('https://github.com/acme/backend/pull/1');
    idx.close();
  });

  it('different commits live as separate rows under one (issue, repo)', () => {
    const idx = freshIndex();
    idx.upsert({ ...baseArgs, commit_sha: 'aaaaaaa' });
    idx.upsert({ ...baseArgs, commit_sha: 'bbbbbbb' });
    expect(idx.listForIssue('iss-1')).toHaveLength(2);
    idx.close();
  });

  it('find requires at least one filter; otherwise returns empty', () => {
    const idx = freshIndex();
    idx.upsert({ ...baseArgs, commit_sha: 'abcdef1' });
    expect(idx.find({})).toEqual([]);
    idx.close();
  });

  it('finds by branch', () => {
    const idx = freshIndex();
    idx.upsert({ ...baseArgs, branch: 'feature/SLONK-1' });
    idx.upsert({ ...baseArgs, issue_id: 'iss-2', issue_key: 'SLONK-2', branch: 'feature/SLONK-2' });
    const rows = idx.find({ branch: 'feature/SLONK-1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.issue_id).toBe('iss-1');
    idx.close();
  });

  it('finds by pr_url', () => {
    const idx = freshIndex();
    idx.upsert({ ...baseArgs, pr_url: 'https://github.com/acme/backend/pull/42' });
    const rows = idx.find({ pr_url: 'https://github.com/acme/backend/pull/42' });
    expect(rows).toHaveLength(1);
    idx.close();
  });

  it('remove by issue+repo+commit removes exactly one row', () => {
    const idx = freshIndex();
    idx.upsert({ ...baseArgs, commit_sha: 'aaaaaaa' });
    idx.upsert({ ...baseArgs, commit_sha: 'bbbbbbb' });
    const removed = idx.remove({ issue_id: 'iss-1', repo_url: baseArgs.repo_url, commit_sha: 'aaaaaaa' });
    expect(removed).toBe(1);
    expect(idx.listForIssue('iss-1')).toHaveLength(1);
    idx.close();
  });

  it('remove without commit_sha removes all rows for (issue, repo)', () => {
    const idx = freshIndex();
    idx.upsert({ ...baseArgs, commit_sha: 'aaaaaaa' });
    idx.upsert({ ...baseArgs, commit_sha: 'bbbbbbb' });
    idx.upsert({ ...baseArgs, branch: 'b' });
    const removed = idx.remove({ issue_id: 'iss-1', repo_url: baseArgs.repo_url });
    expect(removed).toBe(3);
    expect(idx.listForIssue('iss-1')).toHaveLength(0);
    idx.close();
  });

  it('rowToPublic converts sentinel empty commit to null', () => {
    const idx = freshIndex();
    idx.upsert({ ...baseArgs, branch: 'b' });
    const [row] = idx.find({ repo_url: baseArgs.repo_url });
    expect(row).toBeDefined();
    expect(rowToPublic(row!).commit_sha).toBeNull();
    idx.close();
  });
});
