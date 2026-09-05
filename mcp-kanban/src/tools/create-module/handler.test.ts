import { describe, expect, it } from 'vitest';
import { createModule } from './handler.js';
import { TtlCache } from '../../cache.js';
import { fakePlane, newWorld, seedAgentsWorkspace } from '../test-fakes.js';

const base = (world: ReturnType<typeof newWorld>) => ({
  plane: fakePlane(world),
  cache: new TtlCache(),
  workspace: 'agents',
  defaultProjectRef: 'SLONK',
});

describe('createModule', () => {
  it('creates a module in the default project', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);

    const r = await createModule({
      ...base(world),
      input: { name: 'Уведомления', description: 'Мультиканальные уведомления' },
    });

    expect(r.ok).toBe(true);
    expect(r.created).toBe(true);
    expect(r.module.name).toBe('Уведомления');
    expect(r.module.description).toBe('Мультиканальные уведомления');
    expect(r.project.identifier).toBe('SLONK');
    expect(world.modules.get(project.id)).toHaveLength(1);
  });

  it('is idempotent by name — second call returns the existing module', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const deps = base(world);

    const first = await createModule({ ...deps, input: { name: 'Notifications' } });
    const second = await createModule({ ...deps, input: { name: 'Notifications' } });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.module.id).toBe(first.module.id);
    expect(world.modules.get(project.id)).toHaveLength(1);
  });

  it('matches existing modules case-insensitively and ignores surrounding spaces', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const deps = base(world);

    await createModule({ ...deps, input: { name: 'Notifications' } });
    const again = await createModule({ ...deps, input: { name: '  notifications ' } });

    expect(again.created).toBe(false);
    expect(world.modules.get(project.id)).toHaveLength(1);
  });

  it('stores the status when provided', async () => {
    const world = newWorld();
    seedAgentsWorkspace(world);

    const r = await createModule({
      ...base(world),
      input: { name: 'Billing', status: 'in-progress' },
    });

    expect(r.module.status).toBe('in-progress');
  });

  it('fails with NOT_FOUND for an unknown project', async () => {
    const world = newWorld();
    seedAgentsWorkspace(world);

    await expect(
      createModule({ ...base(world), input: { name: 'X', project: 'NOPE' } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
