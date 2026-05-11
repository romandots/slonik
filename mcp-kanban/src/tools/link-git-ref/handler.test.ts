import { describe, expect, it } from 'vitest';
import { linkGitRef } from './handler.js';
import { TtlCache } from '../../cache.js';
import { GitRefsIndex } from '../../git-refs.js';
import { addIssue, fakePlane, newWorld, seedAgentsWorkspace } from '../test-fakes.js';
import { parseDescription, MetaBlockMarker } from '../../meta-block.js';

const REPO = 'https://github.com/acme/backend';

describe('linkGitRef', () => {
  it('adds a fresh ref to an issue without prior meta', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, {
      name: 'Implement auth',
      state: 'st-To Do',
      description: 'Initial description.',
    });
    const plane = fakePlane(world);
    const gitRefs = new GitRefsIndex({ path: ':memory:' });

    const r = await linkGitRef({
      plane,
      cache: new TtlCache(),
      gitRefs,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      input: {
        issue_id: issue.id,
        repo_url: REPO,
        branch: 'feature/SLONK-1-auth',
        commit: 'abcdef1',
      },
    });

    expect(r.meta_was_corrupt).toBe(false);
    expect(r.meta.repos).toHaveLength(1);
    expect(r.meta.repos[0]?.url).toBe(REPO);
    expect(r.meta.repos[0]?.commits).toEqual(['abcdef1']);

    // Plane description должно быть переписано с meta-блоком.
    const fresh = await plane.getIssue('agents', project.id, issue.id);
    expect(fresh?.description).toContain(MetaBlockMarker);
    expect(fresh?.description).toContain('Initial description.');

    // SQLite-индекс заполнен.
    const indexed = gitRefs.find({ commit_sha: 'abcdef1' });
    expect(indexed).toHaveLength(1);
    expect(indexed[0]?.issue_id).toBe(issue.id);

    gitRefs.close();
  });

  it('is idempotent: re-linking the same (repo, commit) does not duplicate', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);
    const gitRefs = new GitRefsIndex({ path: ':memory:' });

    const input = {
      issue_id: issue.id,
      repo_url: REPO,
      branch: 'feature/SLONK-1',
      commit: 'abcdef1',
    };

    const r1 = await linkGitRef({
      plane,
      cache: new TtlCache(),
      gitRefs,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      input,
    });
    const r2 = await linkGitRef({
      plane,
      cache: new TtlCache(),
      gitRefs,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      input,
    });

    expect(r1.meta.repos).toHaveLength(1);
    expect(r2.meta.repos).toHaveLength(1);
    expect(r2.meta.repos[0]?.commits).toEqual(['abcdef1']);
    expect(gitRefs.listForIssue(issue.id)).toHaveLength(1);
    gitRefs.close();
  });

  it('merges branch + pr_url over multiple calls under one repo', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);
    const gitRefs = new GitRefsIndex({ path: ':memory:' });

    await linkGitRef({
      plane,
      cache: new TtlCache(),
      gitRefs,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      input: { issue_id: issue.id, repo_url: REPO, branch: 'feature/x', commit: 'aaaaaaa' },
    });
    const r = await linkGitRef({
      plane,
      cache: new TtlCache(),
      gitRefs,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      input: {
        issue_id: issue.id,
        repo_url: REPO,
        pr_url: 'https://github.com/acme/backend/pull/1',
        commit: 'bbbbbbb',
      },
    });

    expect(r.meta.repos).toHaveLength(1);
    expect(r.meta.repos[0]?.commits).toEqual(['aaaaaaa', 'bbbbbbb']);
    expect(r.meta.repos[0]?.pr).toBe('https://github.com/acme/backend/pull/1');
    expect(r.meta.repos[0]?.branch).toBe('feature/x');
    gitRefs.close();
  });

  it('preserves corrupt meta block, writes fresh one, applies needs-human label', async () => {
    const world = newWorld();
    const { project, labels } = seedAgentsWorkspace(world);
    const corruptDescription = `Body content.

---
${MetaBlockMarker}
repos:
  - url: https://example.com/x
    commits: [ "NOT_A_HEX_SHA" ]
`;
    const issue = addIssue(world, project.id, {
      name: 'Corrupt',
      state: 'st-To Do',
      description: corruptDescription,
    });
    const plane = fakePlane(world);
    const gitRefs = new GitRefsIndex({ path: ':memory:' });

    const r = await linkGitRef({
      plane,
      cache: new TtlCache(),
      gitRefs,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      input: {
        issue_id: issue.id,
        repo_url: REPO,
        branch: 'feature/SLONK-1',
        commit: 'abcdef1',
      },
    });

    expect(r.meta_was_corrupt).toBe(true);
    expect(r.meta_recovered).toBe(true);
    expect(r.meta.repos).toHaveLength(1);
    expect(r.meta.repos[0]?.url).toBe(REPO);

    const fresh = await plane.getIssue('agents', project.id, issue.id);
    // Сломанный блок сохранён внутри fence-quote.
    expect(fresh?.description).toContain('slonk:corrupt-meta-preserved');
    expect(fresh?.description).toContain('NOT_A_HEX_SHA');
    // И есть валидный новый meta.
    const parsed = parseDescription(fresh?.description ?? '');
    expect(parsed.corrupt).toBe(false);
    expect(parsed.meta.repos[0]?.commits).toEqual(['abcdef1']);

    // Лейбл needs-human навешен.
    const needsHuman = labels.find((l) => l.name === 'needs-human');
    expect(needsHuman).toBeDefined();
    expect(fresh?.labels).toContain(needsHuman!.id);

    gitRefs.close();
  });

  it('throws INVALID_INPUT when no branch/pr/commit provided', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);
    const gitRefs = new GitRefsIndex({ path: ':memory:' });

    const { LinkGitRefInput } = await import('./schema.js');
    expect(() => LinkGitRefInput.parse({ issue_id: issue.id, repo_url: REPO })).toThrow();

    void plane;
    gitRefs.close();
  });
});
