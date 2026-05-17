import { describe, expect, it } from 'vitest';
import { claimIssue, resolveStateWithAliases } from './handler.js';
import { TtlCache } from '../../cache.js';
import { AuditLog, newTraceId } from '../../audit.js';
import { IdentityStore } from '../../bootstrap/store.js';
import { addIssue, fakePlane, newWorld, seedAgentsWorkspace } from '../test-fakes.js';
import { McpError } from '../../errors.js';
import type { PlaneState } from '../../plane-client.js';

/**
 * Создаёт in-memory IdentityStore с дефолтными identity для тестов.
 * SLONK-6: claim_issue читает default_state и state_aliases отсюда, а не
 * из захардкоженной таблицы.
 */
function seedStore(extra: Partial<Record<string, { default_state: string; state_aliases?: string[] }>> = {}): IdentityStore {
  const store = new IdentityStore({ path: ':memory:' });
  const defaults: Record<string, string> = {
    'analyst-agent': 'Analysis',
    'developer-agent': 'Development',
    'security-auditor-agent': 'Security Review',
    'code-review-agent': 'Code Review',
    'qa-agent': 'Testing',
    'doc-agent': 'Documenting',
    'merger-agent': 'Merging',
  };
  for (const [role, defaultState] of Object.entries(defaults)) {
    const override = extra[role];
    store.upsert({
      role,
      email: `${role}@slonk.local`,
      plane_user_id: null,
      mode: 'per_user',
      default_state: override?.default_state ?? defaultState,
      state_aliases: override?.state_aliases ?? [],
    });
  }
  return store;
}

describe('claimIssue', () => {
  it('claims an issue: assigns user, adds agent-claimed label, transitions state', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);
    const audit = new AuditLog({ path: ':memory:' });
    const identityStore = seedStore();

    const r = await claimIssue({
      plane,
      cache: new TtlCache(),
      audit,
      identityStore,
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
    identityStore.close();
  });

  it('returns CONFLICT on concurrent claim of the same issue', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);
    const audit = new AuditLog({ path: ':memory:' });
    const identityStore = seedStore();

    // Simulate two agents racing on the same issue. The atomic SQLite insert
    // is the serialization point — only one can succeed.
    const claim = (id: 'developer-agent' | 'qa-agent'): Promise<unknown> =>
      claimIssue({
        plane,
        cache: new TtlCache(),
        audit,
        identityStore,
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
    identityStore.close();
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
    const identityStore = seedStore();

    await expect(
      claimIssue({
        plane,
        cache: new TtlCache(),
        audit,
        identityStore,
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
      identityStore,
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
    identityStore.close();
  });

  it('SLONK-6: uses default_state from IdentityStore for custom identity', async () => {
    // Кастомная роль `release-agent` с default_state="Done" — bootstrap уже
    // прописал её в стор. claim_issue должен перевести задачу в Done без
    // правок кода.
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);
    const audit = new AuditLog({ path: ':memory:' });
    const identityStore = seedStore();
    identityStore.upsert({
      role: 'release-agent',
      email: 'release-agent@slonk.local',
      plane_user_id: null,
      mode: 'per_user',
      default_state: 'Done',
      state_aliases: [],
    });

    const r = await claimIssue({
      plane,
      cache: new TtlCache(),
      audit,
      identityStore,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      identity: 'release-agent',
      traceId: newTraceId(),
      planeUserId: null,
      input: { issue_id: issue.id },
    });

    expect(r.state?.name).toBe('Done');
    audit.close();
    identityStore.close();
  });

  it('SLONK-6: resolves default_state via state_aliases (case-insensitive)', async () => {
    // Канбан с локализованной колонкой: вместо "Development" — "Разработка".
    // Роль развешена через alias.
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    // Подменяем имя started-колонки на «Разработка».
    const states = world.states.get(project.id)!;
    const devIdx = states.findIndex((s) => s.name === 'Development');
    states[devIdx] = { ...states[devIdx]!, name: 'Разработка' };
    addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);
    const audit = new AuditLog({ path: ':memory:' });
    const identityStore = seedStore({
      'developer-agent': { default_state: 'Development', state_aliases: ['Разработка', 'Coding'] },
    });

    const r = await claimIssue({
      plane,
      cache: new TtlCache(),
      audit,
      identityStore,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      identity: 'developer-agent',
      traceId: newTraceId(),
      planeUserId: null,
      input: { issue_id: 'SLONK-1' },
    });

    expect(r.state?.name).toBe('Разработка');
    audit.close();
    identityStore.close();
  });

  it('SLONK-6: target_state override beats default_state from store', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);
    const audit = new AuditLog({ path: ':memory:' });
    const identityStore = seedStore();

    const r = await claimIssue({
      plane,
      cache: new TtlCache(),
      audit,
      identityStore,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      identity: 'developer-agent',
      traceId: newTraceId(),
      planeUserId: null,
      input: { issue_id: 'SLONK-1', target_state: 'Done' },
    });

    expect(r.state?.name).toBe('Done');
    audit.close();
    identityStore.close();
  });

  it('SLONK-6: INVALID_INPUT when role has no default_state and no override', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);
    const audit = new AuditLog({ path: ':memory:' });
    // Store без записи для роли.
    const identityStore = new IdentityStore({ path: ':memory:' });

    await expect(
      claimIssue({
        plane,
        cache: new TtlCache(),
        audit,
        identityStore,
        workspace: 'agents',
        defaultProjectRef: 'SLONK',
        allowedProjects: ['SLONK'],
        identity: 'ghost-agent',
        traceId: newTraceId(),
        planeUserId: null,
        input: { issue_id: 'SLONK-1' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    audit.close();
    identityStore.close();
  });

  it('SLONK-6: INVALID_INPUT with helpful message when state name not in project', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);
    const audit = new AuditLog({ path: ':memory:' });
    // Роль с default_state, которого в проекте нет.
    const identityStore = seedStore({
      'developer-agent': { default_state: 'Sprint Planning', state_aliases: [] },
    });

    await expect(
      claimIssue({
        plane,
        cache: new TtlCache(),
        audit,
        identityStore,
        workspace: 'agents',
        defaultProjectRef: 'SLONK',
        allowedProjects: ['SLONK'],
        identity: 'developer-agent',
        traceId: newTraceId(),
        planeUserId: null,
        input: { issue_id: 'SLONK-1' },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringMatching(/Sprint Planning.*Available states/i) as unknown as string,
    });

    audit.close();
    identityStore.close();
  });
});

describe('resolveStateWithAliases', () => {
  const states: PlaneState[] = [
    {
      id: 'st-1',
      name: 'Development',
      group: 'started',
      color: '#000',
      sequence: 1,
      default: false,
      project: 'p',
      workspace: 'w',
    },
    {
      id: 'st-2',
      name: 'Разработка',
      group: 'started',
      color: '#000',
      sequence: 2,
      default: false,
      project: 'p',
      workspace: 'w',
    },
    {
      id: 'st-3',
      name: 'Done',
      group: 'completed',
      color: '#000',
      sequence: 3,
      default: false,
      project: 'p',
      workspace: 'w',
    },
  ];

  it('resolves by exact name', () => {
    expect(
      resolveStateWithAliases('Development', [], states, {
        identity: 'r',
        projectIdentifier: 'P',
      }),
    ).toBe('st-1');
  });

  it('resolves by id', () => {
    expect(
      resolveStateWithAliases('st-3', [], states, { identity: 'r', projectIdentifier: 'P' }),
    ).toBe('st-3');
  });

  it('resolves case-insensitively', () => {
    expect(
      resolveStateWithAliases('development', [], states, {
        identity: 'r',
        projectIdentifier: 'P',
      }),
    ).toBe('st-1');
  });

  it('resolves via alias when canonical default_state is not in project', () => {
    // ref='Development', но колонка называется «Разработка»; alias-список
    // содержит «Разработка» — должен найти.
    expect(
      resolveStateWithAliases('Development', ['Разработка'], states, {
        identity: 'r',
        projectIdentifier: 'P',
      }),
    ).toBe('st-1'); // первый матч (exact) выигрывает; уберём Development и проверим
  });

  it('resolves via alias when state column is renamed', () => {
    const renamed: PlaneState[] = [
      { ...states[1]! }, // только «Разработка»
      { ...states[2]! },
    ];
    expect(
      resolveStateWithAliases('Development', ['Разработка'], renamed, {
        identity: 'r',
        projectIdentifier: 'P',
      }),
    ).toBe('st-2');
  });

  it('throws INVALID_INPUT with project/aliases context when nothing matches', () => {
    expect(() =>
      resolveStateWithAliases('Sprint', ['Спринт'], states, {
        identity: 'release-agent',
        projectIdentifier: 'WEB',
      }),
    ).toThrow(McpError);
    try {
      resolveStateWithAliases('Sprint', ['Спринт'], states, {
        identity: 'release-agent',
        projectIdentifier: 'WEB',
      });
    } catch (err) {
      const e = err as McpError;
      expect(e.code).toBe('INVALID_INPUT');
      expect(e.message).toContain('Sprint');
      expect(e.message).toContain('Спринт');
      expect(e.message).toContain('WEB');
      expect(e.message).toContain('Development');
      expect(e.message).toContain('release-agent');
    }
  });
});
