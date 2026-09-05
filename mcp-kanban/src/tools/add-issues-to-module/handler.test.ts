import { describe, expect, it } from 'vitest';
import { addIssuesToModule } from './handler.js';
import { createModule } from '../create-module/handler.js';
import { listModules } from '../list-modules/handler.js';
import { TtlCache } from '../../cache.js';
import { addIssue, fakePlane, newWorld, seedAgentsWorkspace } from '../test-fakes.js';

const base = (world: ReturnType<typeof newWorld>) => ({
  plane: fakePlane(world),
  cache: new TtlCache(),
  workspace: 'agents',
  defaultProjectRef: 'SLONK',
});

describe('addIssuesToModule', () => {
  it('adds issues referenced by UUID and by key', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const deps = base(world);
    const a = addIssue(world, project.id, { name: 'A', state: 'st-To Do', sequence_id: 1 });
    addIssue(world, project.id, { name: 'B', state: 'st-To Do', sequence_id: 2 });
    await createModule({ ...deps, input: { name: 'Notifications' } });

    const r = await addIssuesToModule({
      ...deps,
      input: { module: 'Notifications', issue_ids: [a.id, 'SLONK-2'] },
    });

    expect(r.ok).toBe(true);
    expect(r.added).toEqual([a.id, 'SLONK-2']);
    expect(r.already_present).toEqual([]);
    expect(r.issues_count).toBe(2);
  });

  it('is idempotent — a repeated call reports already_present and adds nothing', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const deps = base(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do', sequence_id: 1 });
    await createModule({ ...deps, input: { name: 'Notifications' } });

    await addIssuesToModule({ ...deps, input: { module: 'Notifications', issue_ids: ['SLONK-1'] } });
    const second = await addIssuesToModule({
      ...deps,
      input: { module: 'Notifications', issue_ids: ['SLONK-1'] },
    });

    expect(second.added).toEqual([]);
    expect(second.already_present).toEqual(['SLONK-1']);
    expect(second.issues_count).toBe(1);
  });

  it('surfaces the count through list_modules', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const deps = base(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do', sequence_id: 1 });
    await createModule({ ...deps, input: { name: 'Notifications' } });
    await addIssuesToModule({ ...deps, input: { module: 'Notifications', issue_ids: ['SLONK-1'] } });

    const listed = await listModules({
      plane: deps.plane,
      cache: new TtlCache(),
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
    });

    expect(listed.modules[0]?.issues_count).toBe(1);
  });

  it('fails with NOT_FOUND for an unknown issue key', async () => {
    const world = newWorld();
    seedAgentsWorkspace(world);
    const deps = base(world);
    await createModule({ ...deps, input: { name: 'Notifications' } });

    await expect(
      addIssuesToModule({ ...deps, input: { module: 'Notifications', issue_ids: ['SLONK-99'] } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects an issue key from another project', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const deps = base(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do', sequence_id: 1 });
    await createModule({ ...deps, input: { name: 'Notifications' } });

    await expect(
      addIssuesToModule({ ...deps, input: { module: 'Notifications', issue_ids: ['OTHER-1'] } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('fails with NOT_FOUND for an unknown module', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do', sequence_id: 1 });

    await expect(
      addIssuesToModule({ ...base(world), input: { module: 'Ghost', issue_ids: ['SLONK-1'] } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
