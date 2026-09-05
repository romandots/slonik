import { describe, expect, it } from 'vitest';
import { updateModule } from './handler.js';
import { createModule } from '../create-module/handler.js';
import { TtlCache } from '../../cache.js';
import { fakePlane, newWorld, seedAgentsWorkspace } from '../test-fakes.js';

const base = (world: ReturnType<typeof newWorld>) => ({
  plane: fakePlane(world),
  cache: new TtlCache(),
  workspace: 'agents',
  defaultProjectRef: 'SLONK',
});

describe('updateModule', () => {
  it('renames a module referenced by its name', async () => {
    const world = newWorld();
    seedAgentsWorkspace(world);
    const deps = base(world);
    await createModule({ ...deps, input: { name: 'Notifications' } });

    const r = await updateModule({
      ...deps,
      input: { module: 'Notifications', name: 'Уведомления' },
    });

    expect(r.ok).toBe(true);
    expect(r.module.name).toBe('Уведомления');
  });

  it('updates description and status by module UUID', async () => {
    const world = newWorld();
    seedAgentsWorkspace(world);
    const deps = base(world);
    const created = await createModule({ ...deps, input: { name: 'Billing' } });

    const r = await updateModule({
      ...deps,
      input: { module: created.module.id, description: 'Оплаты', status: 'completed' },
    });

    expect(r.module.description).toBe('Оплаты');
    expect(r.module.status).toBe('completed');
    expect(r.module.name).toBe('Billing');
  });

  it('rejects an update with no fields to change', async () => {
    const world = newWorld();
    seedAgentsWorkspace(world);
    const deps = base(world);
    await createModule({ ...deps, input: { name: 'Billing' } });

    await expect(updateModule({ ...deps, input: { module: 'Billing' } })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('rejects renaming onto an existing module name', async () => {
    const world = newWorld();
    seedAgentsWorkspace(world);
    const deps = base(world);
    await createModule({ ...deps, input: { name: 'Billing' } });
    await createModule({ ...deps, input: { name: 'Notifications' } });

    await expect(
      updateModule({ ...deps, input: { module: 'Billing', name: 'notifications' } }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('allows a no-op rename to the module own name', async () => {
    const world = newWorld();
    seedAgentsWorkspace(world);
    const deps = base(world);
    await createModule({ ...deps, input: { name: 'Billing' } });

    const r = await updateModule({ ...deps, input: { module: 'Billing', name: 'billing' } });

    expect(r.module.name).toBe('billing');
  });

  it('fails with NOT_FOUND for an unknown module', async () => {
    const world = newWorld();
    seedAgentsWorkspace(world);

    await expect(
      updateModule({ ...base(world), input: { module: 'Ghost', name: 'X' } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
