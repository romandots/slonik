import { describe, expect, it } from 'vitest';
import { listIssues } from './handler.js';
import { TtlCache } from '../../cache.js';
import { addIssue, fakePlane, newWorld, seedAgentsWorkspace } from '../test-fakes.js';

describe('listIssues', () => {
  it('returns issues for the default project with state/label resolution', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do', labels: ['lb-bug'] });
    addIssue(world, project.id, { name: 'B', state: 'st-Development', labels: ['lb-feature'] });
    const plane = fakePlane(world);
    const r = await listIssues({
      plane,
      cache: new TtlCache(),
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      input: {},
    });
    expect(r.issues).toHaveLength(2);
    expect(r.issues[0]?.state?.name).toBe('To Do');
    expect(r.issues[0]?.labels).toEqual(['bug']);
    expect(r.issues[0]?.key).toBe('SLONK-1');
  });

  it('filters by state name (resolved to id)', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    addIssue(world, project.id, { name: 'B', state: 'st-Development' });
    const plane = fakePlane(world);
    const r = await listIssues({
      plane,
      cache: new TtlCache(),
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      input: { state: 'Development' },
    });
    expect(r.issues.map((i) => i.name)).toEqual(['B']);
  });

  it('rejects unknown project (allow-list)', async () => {
    const world = newWorld();
    seedAgentsWorkspace(world);
    const plane = fakePlane(world);
    await expect(
      listIssues({
        plane,
        cache: new TtlCache(),
        workspace: 'agents',
        defaultProjectRef: 'SLONK',
        allowedProjects: ['SLONK'],
        input: { project: 'OTHER' },
      }),
    ).rejects.toThrowError(/MCP_ALLOWED_PROJECTS/);
  });

  it('honours the in-memory cache (second call does not hit Plane again)', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);
    let calls = 0;
    // оборачиваем listIssues, чтобы посчитать обращения
    const origListIssues = plane.listIssues.bind(plane);
    plane.listIssues = (async (...args: Parameters<typeof origListIssues>) => {
      calls += 1;
      return origListIssues(...args);
    }) as typeof plane.listIssues;

    const cache = new TtlCache();
    const opts = {
      plane,
      cache,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      input: { state: 'To Do' as const },
    };
    await listIssues(opts);
    await listIssues(opts);
    expect(calls).toBe(1);
  });
});
