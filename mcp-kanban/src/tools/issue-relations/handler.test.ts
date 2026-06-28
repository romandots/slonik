import { describe, expect, it } from 'vitest';
import { issueRelations } from './handler.js';
import { TtlCache } from '../../cache.js';
import { addIssue, fakePlane, newWorld, seedAgentsWorkspace } from '../test-fakes.js';

describe('issueRelations', () => {
  it('list returns empty array when no relations', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);

    const r = await issueRelations({
      plane,
      cache: new TtlCache(),
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      input: { issue_id: issue.id, action: 'list' },
    });

    expect(r.ok).toBe(true);
    expect(r.action).toBe('list');
    expect(r.relations).toEqual([]);
  });

  it('add creates a relation and returns it in the list', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issueA = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const issueB = addIssue(world, project.id, { name: 'B', state: 'st-To Do' });
    const plane = fakePlane(world);

    const r = await issueRelations({
      plane,
      cache: new TtlCache(),
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      input: {
        issue_id: issueA.id,
        action: 'add',
        relation_type: 'relates_to',
        related_issue_id: issueB.id,
      },
    });

    expect(r.ok).toBe(true);
    expect(r.action).toBe('add');
    expect(r.created).toBeDefined();
    expect(r.created?.relation_type).toBe('relates_to');
    expect(r.created?.related_issue_id).toBe(issueB.id);
    expect(r.relations).toHaveLength(1);
  });

  it('add accepts sequence-id references (SLONK-N)', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issueA = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    addIssue(world, project.id, { name: 'B', state: 'st-To Do', sequence_id: 7 });
    const plane = fakePlane(world);

    const r = await issueRelations({
      plane,
      cache: new TtlCache(),
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      input: {
        issue_id: issueA.id,
        action: 'add',
        relation_type: 'blocked_by',
        related_issue_id: 'SLONK-7',
      },
    });

    expect(r.action).toBe('add');
    expect(r.created?.relation_type).toBe('blocked_by');
  });

  it('remove deletes a relation', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issueA = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const issueB = addIssue(world, project.id, { name: 'B', state: 'st-To Do' });
    const plane = fakePlane(world);

    await issueRelations({
      plane,
      cache: new TtlCache(),
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      input: {
        issue_id: issueA.id,
        action: 'add',
        relation_type: 'duplicate_of',
        related_issue_id: issueB.id,
      },
    });

    const r = await issueRelations({
      plane,
      cache: new TtlCache(),
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      input: {
        issue_id: issueA.id,
        action: 'remove',
        relation_type: 'duplicate_of',
        related_issue_id: issueB.id,
      },
    });

    expect(r.action).toBe('remove');
    expect(r.removed_id).toBeDefined();
    expect(r.relations).toHaveLength(0);
  });

  it('remove throws NOT_FOUND when relation does not exist', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issueA = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const issueB = addIssue(world, project.id, { name: 'B', state: 'st-To Do' });
    const plane = fakePlane(world);

    await expect(
      issueRelations({
        plane,
        cache: new TtlCache(),
        workspace: 'agents',
        defaultProjectRef: 'SLONK',
        input: {
          issue_id: issueA.id,
          action: 'remove',
          relation_type: 'blocking',
          related_issue_id: issueB.id,
        },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('add throws INVALID_INPUT when relation_type missing', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);

    await expect(
      issueRelations({
        plane,
        cache: new TtlCache(),
        workspace: 'agents',
        defaultProjectRef: 'SLONK',
        input: { issue_id: issue.id, action: 'add', related_issue_id: 'iss-999' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
