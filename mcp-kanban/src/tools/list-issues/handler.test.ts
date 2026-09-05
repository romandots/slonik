import { describe, expect, it } from 'vitest';
import { listIssues } from './handler.js';
import { MAX_PAGES_PER_CALL, PAGE_SIZE } from './scan.js';
import { TtlCache } from '../../cache.js';
import { addIssue, fakePlane, newWorld, seedAgentsWorkspace } from '../test-fakes.js';

// SLONK-37. Фейковый Plane намеренно не фильтрует (как настоящий), поэтому
// каждый тест ниже проверяет именно нашу фильтрацию, а не фильтрацию фейка.
// Главный риск регрессии — не падение, а тихий возврат «последних N карточек».

const base = (world: ReturnType<typeof newWorld>) => ({
  plane: fakePlane(world),
  cache: new TtlCache(),
  workspace: 'agents',
  defaultProjectRef: 'SLONK',
});

describe('listIssues', () => {
  it('returns issues for the default project with state/label resolution', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do', labels: ['lb-bug'] });
    addIssue(world, project.id, { name: 'B', state: 'st-Development', labels: ['lb-feature'] });
    const r = await listIssues({ ...base(world), input: {} });
    expect(r.issues).toHaveLength(2);
    expect(r.issues[0]?.state?.name).toBe('To Do');
    expect(r.issues[0]?.labels).toEqual(['bug']);
    expect(r.issues[0]?.key).toBe('SLONK-1');
    expect(r.has_more).toBe(false);
  });

  it('filters by state name and returns nothing from other states', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    addIssue(world, project.id, { name: 'B', state: 'st-Development' });
    addIssue(world, project.id, { name: 'C', state: 'st-Done' });
    const r = await listIssues({ ...base(world), input: { state: 'To Do' } });
    expect(r.issues.map((i) => i.name)).toEqual(['A']);
    expect(r.issues.every((i) => i.state?.name === 'To Do')).toBe(true);
  });

  it('accepts a state UUID as well as a name', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    addIssue(world, project.id, { name: 'B', state: 'st-Done' });
    const r = await listIssues({ ...base(world), input: { state: 'st-To Do' } });
    expect(r.issues.map((i) => i.name)).toEqual(['A']);
  });

  it('treats a state array as OR', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    addIssue(world, project.id, { name: 'B', state: 'st-Development' });
    addIssue(world, project.id, { name: 'C', state: 'st-Done' });
    const r = await listIssues({
      ...base(world),
      input: { state: ['To Do', 'Development'] },
    });
    expect(r.issues.map((i) => i.name)).toEqual(['A', 'B']);
  });

  it('errors on an unknown state instead of returning everything', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    await expect(
      listIssues({ ...base(world), input: { state: 'To DO NOT EXIST' } }),
    ).rejects.toThrowError(/Unknown state: To DO NOT EXIST.*Known states/s);
  });

  it('filters by label', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do', labels: ['lb-bug'] });
    addIssue(world, project.id, { name: 'B', state: 'st-To Do', labels: ['lb-feature'] });
    addIssue(world, project.id, { name: 'C', state: 'st-To Do' });
    const r = await listIssues({ ...base(world), input: { label: 'bug' } });
    expect(r.issues.map((i) => i.name)).toEqual(['A']);
  });

  it('returns an EMPTY list for an unknown label (never the whole board)', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do', labels: ['lb-bug'] });
    addIssue(world, project.id, { name: 'B', state: 'st-To Do' });
    const r = await listIssues({
      ...base(world),
      input: { label: 'nonexistent-label-xyz-12345' },
    });
    expect(r.issues).toEqual([]);
    expect(r.has_more).toBe(false);
  });

  it('keeps the known half of a mixed known/unknown label array', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do', labels: ['lb-bug'] });
    addIssue(world, project.id, { name: 'B', state: 'st-To Do', labels: ['lb-feature'] });
    const r = await listIssues({
      ...base(world),
      input: { label: ['bug', 'nope-not-a-label'] },
    });
    expect(r.issues.map((i) => i.name)).toEqual(['A']);
  });

  it('combines state and label as AND', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do', labels: ['lb-bug'] });
    addIssue(world, project.id, { name: 'B', state: 'st-Done', labels: ['lb-bug'] });
    addIssue(world, project.id, { name: 'C', state: 'st-To Do', labels: ['lb-feature'] });
    const r = await listIssues({
      ...base(world),
      input: { state: 'To Do', label: 'bug' },
    });
    expect(r.issues.map((i) => i.name)).toEqual(['A']);
  });

  it('filters by priority and rejects an unknown one', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do', priority: 'high' });
    addIssue(world, project.id, { name: 'B', state: 'st-To Do', priority: 'low' });
    const r = await listIssues({ ...base(world), input: { priority: 'high' } });
    expect(r.issues.map((i) => i.name)).toEqual(['A']);
    await expect(
      listIssues({ ...base(world), input: { priority: 'critical' } }),
    ).rejects.toThrowError(/Unknown priority: critical/);
  });

  it('matches issues without a priority against "none"', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    addIssue(world, project.id, { name: 'B', state: 'st-To Do', priority: 'high' });
    const r = await listIssues({ ...base(world), input: { priority: 'none' } });
    expect(r.issues.map((i) => i.name)).toEqual(['A']);
  });

  it('resolves an assignee by e-mail and rejects an unknown one', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    world.members.set('agents', [{ id: 'u-1', email: 'dev@example.com', display_name: 'dev' }]);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do', assignees: ['u-1'] });
    addIssue(world, project.id, { name: 'B', state: 'st-To Do' });
    const r = await listIssues({ ...base(world), input: { assignee: 'dev@example.com' } });
    expect(r.issues.map((i) => i.name)).toEqual(['A']);
    await expect(
      listIssues({ ...base(world), input: { assignee: 'ghost@example.com' } }),
    ).rejects.toThrowError(/Unknown assignee/);
  });

  it('errors on a cycle filter when Plane does not expose the field', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    await expect(
      listIssues({ ...base(world), input: { cycle: 'cy-1' } }),
    ).rejects.toThrowError(/does not expose `cycle`/);
  });

  it('filters by cycle when the field is present', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do', cycle: 'cy-1' });
    addIssue(world, project.id, { name: 'B', state: 'st-To Do', cycle: null });
    const r = await listIssues({ ...base(world), input: { cycle: 'cy-1' } });
    expect(r.issues.map((i) => i.name)).toEqual(['A']);
  });

  it('rejects unknown project (allow-list)', async () => {
    const world = newWorld();
    seedAgentsWorkspace(world);
    await expect(
      listIssues({ ...base(world), input: { project: 'OTHER' } }),
    ).rejects.toThrowError(/not found in workspace/);
  });

  it('honours the in-memory cache (second call does not hit Plane again)', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const deps = base(world);
    const opts = { ...deps, input: { state: 'To Do' as const } };
    await listIssues(opts);
    await listIssues(opts);
    expect(world.issuePageCalls).toHaveLength(1);
  });
});

describe('listIssues pagination (SLONK-37)', () => {
  const seedMany = (count: number) => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    for (let n = 1; n <= count; n += 1) {
      addIssue(world, project.id, {
        name: `issue-${n}`,
        // Каждая третья — в To Do, остальные в Done: фильтр разрежённый,
        // как на реальной доске, где Done в разы больше входной колонки.
        state: n % 3 === 0 ? 'st-To Do' : 'st-Done',
      });
    }
    return world;
  };

  it('walks a board longer than the limit page by page, without gaps or duplicates', async () => {
    const world = seedMany(250);
    const deps = base(world);
    const seen: string[] = [];
    let cursor: string | undefined;
    let calls = 0;
    do {
      const r = await listIssues({
        ...deps,
        input: { limit: 50, ...(cursor !== undefined ? { cursor } : {}) },
      });
      seen.push(...r.issues.map((i) => i.name));
      cursor = r.next_cursor;
      calls += 1;
      expect(calls).toBeLessThan(20);
    } while (cursor !== undefined);

    expect(seen).toHaveLength(250);
    expect(new Set(seen).size).toBe(250);
    expect(seen[0]).toBe('issue-1');
    expect(seen[249]).toBe('issue-250');
  });

  it('walks a filtered board of >200 issues to completion', async () => {
    const world = seedMany(250);
    const deps = base(world);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await listIssues({
        ...deps,
        input: { state: 'To Do', limit: 20, ...(cursor !== undefined ? { cursor } : {}) },
      });
      expect(r.issues.every((i) => i.state?.name === 'To Do')).toBe(true);
      seen.push(...r.issues.map((i) => i.name));
      cursor = r.next_cursor;
    } while (cursor !== undefined);

    // 83 задачи с номером, кратным трём, в диапазоне 1..250.
    expect(seen).toHaveLength(83);
    expect(new Set(seen).size).toBe(83);
  });

  it('reports has_more when it stops on the page budget without filling the limit', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const total = PAGE_SIZE * (MAX_PAGES_PER_CALL + 2);
    for (let n = 1; n <= total; n += 1) {
      addIssue(world, project.id, { name: `issue-${n}`, state: 'st-Done' });
    }
    addIssue(world, project.id, { name: 'needle', state: 'st-To Do' });

    const deps = base(world);
    const first = await listIssues({ ...deps, input: { state: 'To Do', limit: 50 } });
    expect(first.issues).toEqual([]);
    expect(first.has_more).toBe(true);
    expect(first.scanned).toBe(PAGE_SIZE * MAX_PAGES_PER_CALL);

    const second = await listIssues({
      ...deps,
      input: { state: 'To Do', limit: 50, cursor: first.next_cursor as string },
    });
    expect(second.issues.map((i) => i.name)).toEqual(['needle']);
    expect(second.has_more).toBe(false);
  });

  it('rejects a malformed cursor', async () => {
    const world = seedMany(5);
    await expect(
      listIssues({ ...base(world), input: { cursor: 'not-a-cursor' } }),
    ).rejects.toThrowError(/Malformed cursor/);
  });
});
