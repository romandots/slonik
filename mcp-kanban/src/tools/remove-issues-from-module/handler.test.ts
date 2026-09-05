import { describe, expect, it } from 'vitest';
import { removeIssuesFromModule } from './handler.js';
import { addIssuesToModule } from '../add-issues-to-module/handler.js';
import { createModule } from '../create-module/handler.js';
import { TtlCache } from '../../cache.js';
import { addIssue, fakePlane, newWorld, seedAgentsWorkspace } from '../test-fakes.js';

const base = (world: ReturnType<typeof newWorld>) => ({
  plane: fakePlane(world),
  cache: new TtlCache(),
  workspace: 'agents',
  defaultProjectRef: 'SLONK',
});

describe('removeIssuesFromModule', () => {
  it('detaches an issue from the module', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const deps = base(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do', sequence_id: 1 });
    addIssue(world, project.id, { name: 'B', state: 'st-To Do', sequence_id: 2 });
    await createModule({ ...deps, input: { name: 'Notifications' } });
    await addIssuesToModule({
      ...deps,
      input: { module: 'Notifications', issue_ids: ['SLONK-1', 'SLONK-2'] },
    });

    const r = await removeIssuesFromModule({
      ...deps,
      input: { module: 'Notifications', issue_ids: ['SLONK-1'] },
    });

    expect(r.ok).toBe(true);
    expect(r.removed).toEqual(['SLONK-1']);
    expect(r.not_in_module).toEqual([]);
    expect(r.issues_count).toBe(1);
  });

  it('is idempotent — removing an issue twice reports not_in_module', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const deps = base(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do', sequence_id: 1 });
    await createModule({ ...deps, input: { name: 'Notifications' } });
    await addIssuesToModule({ ...deps, input: { module: 'Notifications', issue_ids: ['SLONK-1'] } });

    await removeIssuesFromModule({
      ...deps,
      input: { module: 'Notifications', issue_ids: ['SLONK-1'] },
    });
    const second = await removeIssuesFromModule({
      ...deps,
      input: { module: 'Notifications', issue_ids: ['SLONK-1'] },
    });

    expect(second.removed).toEqual([]);
    expect(second.not_in_module).toEqual(['SLONK-1']);
    expect(second.issues_count).toBe(0);
  });

  it('fails with NOT_FOUND for an unknown module', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do', sequence_id: 1 });

    await expect(
      removeIssuesFromModule({ ...base(world), input: { module: 'Ghost', issue_ids: ['SLONK-1'] } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
