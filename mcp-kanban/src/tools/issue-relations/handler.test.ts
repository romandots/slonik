import { describe, expect, it } from 'vitest';
import { flattenRelationGroups, issueRelations } from './handler.js';
import { TtlCache } from '../../cache.js';
import { PlaneError } from '../../errors.js';
import type { PlaneClient } from '../../plane-client.js';
import { addIssue, fakePlane, newWorld, seedAgentsWorkspace } from '../test-fakes.js';

const base = {
  cache: new TtlCache(),
  workspace: 'agents',
  defaultProjectRef: 'SLONK',
};

describe('issueRelations', () => {
  it('list returns empty array when no relations', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });

    const r = await issueRelations({
      ...base,
      cache: new TtlCache(),
      plane: fakePlane(world),
      input: { issue_id: issue.id, action: 'list' },
    });

    expect(r.ok).toBe(true);
    expect(r.action).toBe('list');
    expect(r.relations).toEqual([]);
  });

  it('add blocked_by creates the relation and returns it in the list', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issueA = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const issueB = addIssue(world, project.id, { name: 'B', state: 'st-To Do', sequence_id: 12 });
    const plane = fakePlane(world);

    const r = await issueRelations({
      ...base,
      cache: new TtlCache(),
      plane,
      input: {
        issue_id: issueA.id,
        action: 'add',
        relation_type: 'blocked_by',
        related_issue_id: issueB.id,
      },
    });

    expect(r.action).toBe('add');
    expect(r.created).toMatchObject({
      relation_type: 'blocked_by',
      related_issue_id: issueB.id,
      related_issue_key: 'SLONK-12',
      related_issue_name: 'B',
    });
    expect(r.relations).toHaveLength(1);
  });

  // Plane хранит `blocking` как обратный `blocked_by`, поэтому связь
  // обязана быть видна с обеих сторон — именно её машинно читают воркеры.
  it('add blocking is visible as blocked_by from the other issue', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issueA = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const issueB = addIssue(world, project.id, { name: 'B', state: 'st-To Do' });
    const plane = fakePlane(world);

    await issueRelations({
      ...base,
      cache: new TtlCache(),
      plane,
      input: {
        issue_id: issueA.id,
        action: 'add',
        relation_type: 'blocking',
        related_issue_id: issueB.id,
      },
    });

    const fromA = await issueRelations({
      ...base,
      cache: new TtlCache(),
      plane,
      input: { issue_id: issueA.id, action: 'list' },
    });
    const fromB = await issueRelations({
      ...base,
      cache: new TtlCache(),
      plane,
      input: { issue_id: issueB.id, action: 'list' },
    });

    expect(fromA.relations).toEqual([
      expect.objectContaining({ relation_type: 'blocking', related_issue_id: issueB.id }),
    ]);
    expect(fromB.relations).toEqual([
      expect.objectContaining({ relation_type: 'blocked_by', related_issue_id: issueA.id }),
    ]);
  });

  it('add accepts sequence-id references (SLONK-N)', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issueA = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    addIssue(world, project.id, { name: 'B', state: 'st-To Do', sequence_id: 7 });

    const r = await issueRelations({
      ...base,
      cache: new TtlCache(),
      plane: fakePlane(world),
      input: {
        issue_id: issueA.id,
        action: 'add',
        relation_type: 'blocked_by',
        related_issue_id: 'SLONK-7',
      },
    });

    expect(r.created).toMatchObject({ relation_type: 'blocked_by', related_issue_key: 'SLONK-7' });
  });

  // `duplicate_of` — исторический алиас контракта MCP (SLONK-33);
  // Plane знает этот тип как `duplicate`.
  it('maps the duplicate_of alias onto Plane duplicate', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issueA = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const issueB = addIssue(world, project.id, { name: 'B', state: 'st-To Do' });

    const r = await issueRelations({
      ...base,
      cache: new TtlCache(),
      plane: fakePlane(world),
      input: {
        issue_id: issueA.id,
        action: 'add',
        relation_type: 'duplicate_of',
        related_issue_id: issueB.id,
      },
    });

    expect(r.created?.relation_type).toBe('duplicate');
  });

  it('add is idempotent — repeating it does not duplicate the relation', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issueA = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const issueB = addIssue(world, project.id, { name: 'B', state: 'st-To Do' });
    const plane = fakePlane(world);
    const input = {
      issue_id: issueA.id,
      action: 'add' as const,
      relation_type: 'relates_to' as const,
      related_issue_id: issueB.id,
    };

    await issueRelations({ ...base, cache: new TtlCache(), plane, input });
    const second = await issueRelations({ ...base, cache: new TtlCache(), plane, input });

    expect(second.relations).toHaveLength(1);
  });

  it('remove reports UNSUPPORTED — the public Plane API has no delete route', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issueA = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const issueB = addIssue(world, project.id, { name: 'B', state: 'st-To Do' });

    await expect(
      issueRelations({
        ...base,
        cache: new TtlCache(),
        plane: fakePlane(world),
        input: {
          issue_id: issueA.id,
          action: 'remove',
          relation_type: 'relates_to',
          related_issue_id: issueB.id,
        },
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  // Старее v1.3.0 роут `relations/` отсутствует: сырой 404 читается
  // агентом как «задачи нет», поэтому переводим его в UNSUPPORTED.
  it('translates a 404 on the relations route into UNSUPPORTED', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);
    const stub = {
      ...plane,
      listIssueRelations: async () => {
        throw new PlaneError({ message: 'Page not found.', planeStatus: 404 });
      },
    } as unknown as PlaneClient;

    await expect(
      issueRelations({
        ...base,
        cache: new TtlCache(),
        plane: stub,
        input: { issue_id: issue.id, action: 'list' },
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('add throws INVALID_INPUT when relation_type missing', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });

    await expect(
      issueRelations({
        ...base,
        cache: new TtlCache(),
        plane: fakePlane(world),
        input: { issue_id: issue.id, action: 'add', related_issue_id: 'iss-999' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('flattenRelationGroups', () => {
  it('flattens Plane groups into entries and skips empty ones', () => {
    expect(
      flattenRelationGroups({
        blocking: ['a'],
        blocked_by: ['b', 'c'],
        duplicate: [],
        relates_to: [],
        start_before: [],
        start_after: [],
        finish_before: ['d'],
        finish_after: [],
      }),
    ).toEqual([
      { relation_type: 'blocking', related_issue_id: 'a' },
      { relation_type: 'blocked_by', related_issue_id: 'b' },
      { relation_type: 'blocked_by', related_issue_id: 'c' },
      { relation_type: 'finish_before', related_issue_id: 'd' },
    ]);
  });
});
