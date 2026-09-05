import { describe, expect, it } from 'vitest';
import { searchIssues } from './handler.js';
import { TtlCache } from '../../cache.js';
import { addIssue, fakePlane, newWorld, seedAgentsWorkspace } from '../test-fakes.js';

// SLONK-37: фейковый Plane не ищет (как и настоящий) — совпадения считает
// наш код. Регрессия здесь выглядела бы как «на любой запрос возвращаются
// последние N карточек», поэтому тест на заведомо отсутствующую строку —
// главный в файле.

const base = (world: ReturnType<typeof newWorld>) => ({
  plane: fakePlane(world),
  cache: new TtlCache(),
  workspace: 'agents',
  defaultProjectRef: 'SLONK',
});

describe('searchIssues', () => {
  it('finds an issue by a substring of its title', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'add auth flow', state: 'st-To Do' });
    addIssue(world, project.id, { name: 'fix billing bug', state: 'st-To Do' });
    const r = await searchIssues({ ...base(world), query: 'auth' });
    expect(r.query).toBe('auth');
    expect(r.issues.map((i) => i.name)).toEqual(['add auth flow']);
  });

  it('returns an EMPTY list for a string no issue contains', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'add auth flow', state: 'st-To Do' });
    addIssue(world, project.id, { name: 'fix billing bug', state: 'st-To Do' });
    const r = await searchIssues({
      ...base(world),
      query: 'zzqqxwv-несуществующая-строка-42',
    });
    expect(r.issues).toEqual([]);
    expect(r.has_more).toBe(false);
  });

  it('is case-insensitive', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'Add Auth Flow', state: 'st-To Do' });
    const r = await searchIssues({ ...base(world), query: 'AUTH' });
    expect(r.issues.map((i) => i.name)).toEqual(['Add Auth Flow']);
  });

  it('searches the description text, ignoring HTML markup', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, {
      name: 'plain title',
      state: 'st-To Do',
      description_html: '<p>rate limit on the <strong>presigned</strong> upload</p>',
    });
    addIssue(world, project.id, { name: 'other', state: 'st-To Do' });

    const r = await searchIssues({ ...base(world), query: 'presigned upload' });
    expect(r.issues.map((i) => i.name)).toEqual(['plain title']);

    // Разметка не должна становиться поисковым индексом.
    const byTag = await searchIssues({ ...base(world), query: 'strong' });
    expect(byTag.issues).toEqual([]);
  });

  it('finds an issue by its key', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'first', state: 'st-To Do' });
    addIssue(world, project.id, { name: 'second', state: 'st-To Do' });
    const r = await searchIssues({ ...base(world), query: 'SLONK-2' });
    expect(r.issues.map((i) => i.name)).toEqual(['second']);
  });

  it('paginates the result set', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    for (let n = 1; n <= 120; n += 1) {
      addIssue(world, project.id, {
        name: n % 2 === 0 ? `needle ${n}` : `haystack ${n}`,
        state: 'st-To Do',
      });
    }
    const deps = base(world);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await searchIssues({
        ...deps,
        query: 'needle',
        limit: 25,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      seen.push(...r.issues.map((i) => i.name));
      cursor = r.next_cursor;
    } while (cursor !== undefined);

    expect(seen).toHaveLength(60);
    expect(new Set(seen).size).toBe(60);
    expect(seen.every((n) => n.startsWith('needle'))).toBe(true);
  });
});
