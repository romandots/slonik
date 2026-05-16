import { describe, expect, it } from 'vitest';
import { createIssue } from './handler.js';
import { getIssue } from '../get-issue/handler.js';
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

  // Регрессия SLONK-7: Plane v1.3.0 хранит тело задачи в `description_html`
  // (TipTap), а поле `description` тихо игнорирует. Тест-фейк теперь
  // моделирует ту же семантику; этот тест проверяет, что MCP корректно
  // конвертит ввод в `description_html` и тело виден через `get_issue`.
  it('round-trips description: createIssue → getIssue returns non-empty body', async () => {
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
      input: { name: 'With body', description: 'Hello\n\nWorld' },
    });
    const fetched = await getIssue({
      plane,
      cache,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      issueRef: created.id,
    });
    expect(fetched.description_body).toContain('Hello');
    expect(fetched.description_body).toContain('World');
    // Параграфы оформлены как HTML — fetched.description_raw это сырое
    // `description_html`, должно содержать <p>-обёртки.
    expect(fetched.description_raw).toContain('<p>Hello</p>');
    expect(fetched.description_raw).toContain('<p>World</p>');
  });

  it('HTML-escapes user input so script tags do not execute in Plane UI', async () => {
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
      input: { name: 'XSS check', description: 'a<script>x</script>b & "q"' },
    });
    const fetched = await getIssue({
      plane,
      cache,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      issueRef: created.id,
    });
    expect(fetched.description_raw).not.toContain('<script>');
    expect(fetched.description_raw).toContain('&lt;script&gt;');
    expect(fetched.description_raw).toContain('&amp;');
    expect(fetched.description_raw).toContain('&quot;');
  });

  it('createIssue without description leaves body empty (no description_html sent)', async () => {
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
      input: { name: 'Empty' },
    });
    const fetched = await getIssue({
      plane,
      cache,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      issueRef: created.id,
    });
    expect(fetched.description_body).toBe('');
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
