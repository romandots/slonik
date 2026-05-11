import { describe, expect, it } from 'vitest';
import { listStates } from './handler.js';
import { TtlCache } from '../../cache.js';
import { fakePlane, newWorld, seedAgentsWorkspace } from '../test-fakes.js';

describe('listStates / listLabels / listProjects (smoke)', () => {
  it('returns all 4 seeded states', async () => {
    const world = newWorld();
    seedAgentsWorkspace(world);
    const plane = fakePlane(world);
    const r = await listStates({
      plane,
      cache: new TtlCache(),
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
    });
    expect(r.states.map((s) => s.name)).toEqual(['Backlog', 'To Do', 'Development', 'Done']);
    expect(r.project.identifier).toBe('SLONK');
  });
});
