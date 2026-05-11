import { describe, expect, it } from 'vitest';
import { searchIssues } from './handler.js';
import { TtlCache } from '../../cache.js';
import { addIssue, fakePlane, newWorld, seedAgentsWorkspace } from '../test-fakes.js';

describe('searchIssues', () => {
  it('passes the query as Plane `search` filter and returns matches', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'add auth flow', state: 'st-To Do' });
    addIssue(world, project.id, { name: 'fix billing bug', state: 'st-To Do' });
    const plane = fakePlane(world);
    const r = await searchIssues({
      plane,
      cache: new TtlCache(),
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      query: 'auth',
    });
    expect(r.query).toBe('auth');
    expect(r.issues.map((i) => i.name)).toEqual(['add auth flow']);
  });
});
