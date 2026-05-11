import { describe, expect, it } from 'vitest';
import { unlinkGitRef } from './handler.js';
import { linkGitRef } from '../link-git-ref/handler.js';
import { TtlCache } from '../../cache.js';
import { GitRefsIndex } from '../../git-refs.js';
import { addIssue, fakePlane, newWorld, seedAgentsWorkspace } from '../test-fakes.js';
import { MetaBlockMarker } from '../../meta-block.js';
import { McpError } from '../../errors.js';

const REPO = 'https://github.com/acme/backend';

describe('unlinkGitRef', () => {
  it('removes a single commit from a multi-commit repo entry', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);
    const gitRefs = new GitRefsIndex({ path: ':memory:' });

    // Setup: link two commits to one repo.
    for (const c of ['aaaaaaa', 'bbbbbbb']) {
      await linkGitRef({
        plane,
        cache: new TtlCache(),
        gitRefs,
        workspace: 'agents',
        defaultProjectRef: 'SLONK',
        allowedProjects: ['SLONK'],
        input: { issue_id: issue.id, repo_url: REPO, branch: 'feature/x', commit: c },
      });
    }

    const r = await unlinkGitRef({
      plane,
      cache: new TtlCache(),
      gitRefs,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      input: { issue_id: issue.id, repo_url: REPO, commit: 'aaaaaaa' },
    });

    expect(r.removed).toBeGreaterThanOrEqual(1);
    expect(r.meta.repos[0]?.commits).toEqual(['bbbbbbb']);
    expect(gitRefs.find({ commit_sha: 'aaaaaaa' })).toHaveLength(0);
    expect(gitRefs.find({ commit_sha: 'bbbbbbb' })).toHaveLength(1);
    gitRefs.close();
  });

  it('drops the entire repo entry when commit is omitted', async () => {
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
      input: { issue_id: issue.id, repo_url: REPO, branch: 'feature/x', commit: 'abcdef1' },
    });

    const r = await unlinkGitRef({
      plane,
      cache: new TtlCache(),
      gitRefs,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      input: { issue_id: issue.id, repo_url: REPO },
    });

    expect(r.meta.repos).toHaveLength(0);
    expect(gitRefs.listForIssue(issue.id)).toHaveLength(0);

    // Описание не должно содержать meta-блока, если все repos удалены.
    const fresh = await plane.getIssue('agents', project.id, issue.id);
    expect(fresh?.description ?? '').not.toContain(MetaBlockMarker);
    gitRefs.close();
  });

  it('returns CONFLICT when meta block is corrupt', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, {
      name: 'A',
      state: 'st-To Do',
      description: `Body.

---
${MetaBlockMarker}
repos:
  - url: https://example.com/x
    commits: [ "NOT_A_HEX_SHA" ]
`,
    });
    const plane = fakePlane(world);
    const gitRefs = new GitRefsIndex({ path: ':memory:' });

    await expect(
      unlinkGitRef({
        plane,
        cache: new TtlCache(),
        gitRefs,
        workspace: 'agents',
        defaultProjectRef: 'SLONK',
        allowedProjects: ['SLONK'],
        input: { issue_id: issue.id, repo_url: REPO },
      }),
    ).rejects.toBeInstanceOf(McpError);
    gitRefs.close();
  });
});
