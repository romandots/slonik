import { describe, expect, it } from 'vitest';
import { claimIssue } from './handler.js';
import { TtlCache } from '../../cache.js';
import { AuditLog, newTraceId } from '../../audit.js';
import { addIssue, fakePlane, newWorld, seedAgentsWorkspace } from '../test-fakes.js';
import { McpError } from '../../errors.js';

describe('claimIssue', () => {
  it('claims an issue: assigns user, adds agent-claimed label, transitions state', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);
    const audit = new AuditLog({ path: ':memory:' });

    const r = await claimIssue({
      plane,
      cache: new TtlCache(),
      audit,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      identity: 'developer-agent',
      traceId: newTraceId(),
      planeUserId: 'usr-dev',
      input: { issue_id: 'SLONK-1' },
    });

    expect(r.state?.name).toBe('Development');
    expect(r.labels).toContain('agent-claimed');
    expect(r.assignees).toContain('usr-dev');
    expect(audit.currentClaim(r.id)?.identity).toBe('developer-agent');
    audit.close();
  });

  it('returns CONFLICT on concurrent claim of the same issue', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);
    const audit = new AuditLog({ path: ':memory:' });

    // Simulate two agents racing on the same issue. The atomic SQLite insert
    // is the serialization point — only one can succeed.
    const claim = (id: 'developer-agent' | 'qa-agent'): Promise<unknown> =>
      claimIssue({
        plane,
        cache: new TtlCache(),
        audit,
        workspace: 'agents',
        defaultProjectRef: 'SLONK',
        allowedProjects: ['SLONK'],
        identity: id,
        traceId: newTraceId(),
        planeUserId: null,
        input: { issue_id: issue.id },
      });

    const settled = await Promise.allSettled([claim('developer-agent'), claim('qa-agent')]);
    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe('CONFLICT');
    audit.close();
  });

  it('rolls back the audit claim if Plane patch throws', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);
    // sabotage Plane.updateIssue to throw
    const origUpdate = plane.updateIssue.bind(plane);
    plane.updateIssue = (async () => {
      throw new Error('Plane offline');
    }) as typeof plane.updateIssue;
    const audit = new AuditLog({ path: ':memory:' });

    await expect(
      claimIssue({
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
      }),
    ).rejects.toThrow(/Plane offline/);

    // claim освобождён, чтобы повторный claim был возможен.
    expect(audit.currentClaim(issue.id)).toBeUndefined();
    // Sanity: исправляем Plane и пробуем снова.
    plane.updateIssue = origUpdate;
    const ok = await claimIssue({
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
    expect(ok.state?.name).toBe('Development');
    audit.close();
  });
});
