import { describe, expect, it } from 'vitest';
import { updateIssue } from './handler.js';
import { createIssue } from '../create-issue/handler.js';
import { getIssue } from '../get-issue/handler.js';
import { TtlCache } from '../../cache.js';
import { addIssue, fakePlane, newWorld, seedAgentsWorkspace } from '../test-fakes.js';

// Регрессионный набор по SLONK-7: убеждаемся, что `update_issue` пишет
// тело в `description_html`, поле описания на чтении не теряется, патч
// без поля description не трогает существующее тело, и спецсимволы
// эскейпятся.
describe('updateIssue (description handling)', () => {
  it('round-trips: updateIssue → getIssue returns new body', async () => {
    const world = newWorld();
    seedAgentsWorkspace(world);
    const plane = fakePlane(world);
    const cache = new TtlCache();
    const created = await createIssue({
      plane,
      cache,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      input: { name: 'Initial', description: 'Old body' },
    });

    await updateIssue({
      plane,
      cache,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      input: { issue_id: created.id, description: 'Replaced' },
    });

    const fetched = await getIssue({
      plane,
      cache,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      issueRef: created.id,
    });
    // description_body — описание без meta-блока; парсер снимает
    // внешний <div>-wrapper, который Plane TipTap навешивает на
    // description_html, но не сдирает остальные HTML-теги, поэтому
    // он содержит обёрнутый параграф.
    expect(fetched.description_body).toBe('<p>Replaced</p>');
    // description_raw — сырой ответ Plane: внутри <div>...</div>-обёртки
    // (TipTap-санитайзер всегда её добавляет, см. SLONK-7).
    expect(fetched.description_raw).toBe('<div><p>Replaced</p></div>');
  });

  it('updates without description: existing body is preserved', async () => {
    const world = newWorld();
    seedAgentsWorkspace(world);
    const plane = fakePlane(world);
    const cache = new TtlCache();
    const created = await createIssue({
      plane,
      cache,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      input: { name: 'Keep body', description: 'Stay here' },
    });

    await updateIssue({
      plane,
      cache,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      input: { issue_id: created.id, priority: 'high' },
    });

    const fetched = await getIssue({
      plane,
      cache,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      issueRef: created.id,
    });
    expect(fetched.description_body).toContain('Stay here');
    expect(fetched.priority).toBe('high');
  });

  it('escapes HTML in the new body', async () => {
    const world = newWorld();
    seedAgentsWorkspace(world);
    const plane = fakePlane(world);
    const cache = new TtlCache();
    const created = await createIssue({
      plane,
      cache,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      input: { name: 'X', description: 'old' },
    });

    await updateIssue({
      plane,
      cache,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      input: { issue_id: created.id, description: '<b>bold</b> & "q"' },
    });

    const fetched = await getIssue({
      plane,
      cache,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      issueRef: created.id,
    });
    expect(fetched.description_raw).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(fetched.description_raw).toContain('&amp;');
    expect(fetched.description_raw).toContain('&quot;');
  });

  it('rejects empty patch (INVALID_INPUT)', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);
    await expect(
      updateIssue({
        plane,
        cache: new TtlCache(),
        workspace: 'agents',
        defaultProjectRef: 'SLONK',
        allowedProjects: ['SLONK'],
        input: { issue_id: issue.id },
      }),
    ).rejects.toThrowError(/no fields to update/);
  });
});
