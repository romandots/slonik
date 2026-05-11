import { describe, expect, it } from 'vitest';
import { createIssue } from './handler.js';
import { TtlCache } from '../../cache.js';
import { fakePlane, newWorld, seedAgentsWorkspace } from '../test-fakes.js';

describe('createIssue', () => {
  it('creates an issue with name + resolved state/label', async () => {
    const world = newWorld();
    seedAgentsWorkspace(world);
    const plane = fakePlane(world);
    const r = await createIssue({
      plane,
      cache: new TtlCache(),
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      input: {
        name: 'Add auth flow',
        state: 'To Do',
        labels: ['feature'],
        priority: 'medium',
      },
    });
    expect(r.name).toBe('Add auth flow');
    expect(r.state?.name).toBe('To Do');
    expect(r.labels).toEqual(['feature']);
    expect(r.priority).toBe('medium');
    expect(r.key).toBe('SLONK-1');
  });

  it('rejects unknown label', async () => {
    const world = newWorld();
    seedAgentsWorkspace(world);
    const plane = fakePlane(world);
    await expect(
      createIssue({
        plane,
        cache: new TtlCache(),
        workspace: 'agents',
        defaultProjectRef: 'SLONK',
        allowedProjects: ['SLONK'],
        input: { name: 'x', labels: ['nonexistent-label'] },
      }),
    ).rejects.toThrowError(/Unknown label/);
  });
});
