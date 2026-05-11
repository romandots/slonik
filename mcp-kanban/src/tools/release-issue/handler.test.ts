import { describe, expect, it } from 'vitest';
import { claimIssue } from '../claim-issue/handler.js';
import { releaseIssue } from './handler.js';
import { TtlCache } from '../../cache.js';
import { AuditLog, newTraceId } from '../../audit.js';
import { addIssue, fakePlane, newWorld, seedAgentsWorkspace } from '../test-fakes.js';
import { McpError } from '../../errors.js';

describe('releaseIssue', () => {
  it('releases own claim and resets state to To Do', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);
    const audit = new AuditLog({ path: ':memory:' });

    await claimIssue({
      plane,
      cache: new TtlCache(),
      audit,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      identity: 'developer-agent',
      traceId: newTraceId(),
      planeUserId: 'usr-dev',
      input: { issue_id: issue.id },
    });

    const r = await releaseIssue({
      plane,
      cache: new TtlCache(),
      audit,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      identity: 'developer-agent',
      planeUserId: 'usr-dev',
      input: { issue_id: issue.id },
    });
    expect(r.state?.name).toBe('To Do');
    expect(r.labels).not.toContain('agent-claimed');
    expect(audit.currentClaim(issue.id)).toBeUndefined();
    audit.close();
  });

  it('rejects release by foreign identity', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);
    const audit = new AuditLog({ path: ':memory:' });
    await claimIssue({
      plane,
      cache: new TtlCache(),
      audit,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      identity: 'developer-agent',
      traceId: newTraceId(),
      planeUserId: 'usr-dev',
      input: { issue_id: issue.id },
    });

    await expect(
      releaseIssue({
        plane,
        cache: new TtlCache(),
        audit,
        workspace: 'agents',
        defaultProjectRef: 'SLONK',
        allowedProjects: ['SLONK'],
        identity: 'qa-agent',
        planeUserId: null,
        input: { issue_id: issue.id },
      }),
    ).rejects.toThrowError(McpError);
    audit.close();
  });
});
