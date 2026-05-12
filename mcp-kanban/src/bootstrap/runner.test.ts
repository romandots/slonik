import { describe, expect, it, beforeEach } from 'vitest';
import pino from 'pino';
import { runBootstrap } from './runner.js';
import { IdentityStore } from './store.js';
import type {
  PlaneClient,
  PlaneCycle,
  PlaneIssue,
  PlaneLabel,
  PlaneModule,
  PlaneProject,
  PlaneState,
  PlaneUser,
  PlaneWorkspace,
} from '../plane-client.js';
import type { Manifest } from './manifest.js';

const silentLogger = pino({ level: 'silent' });

function makeManifest(): Manifest {
  return {
    workspace: { slug: 'agents', name: 'Code Agents' },
    projects: [
      { slug: 'code-agents', name: 'Code Agents', identifier: 'SLONK', modules: ['cycles'] },
    ],
    states: [
      { name: 'Backlog', group: 'backlog', color: '#94a3b8', order: 1, default: true },
      { name: 'To Do', group: 'unstarted', color: '#3b82f6', order: 2 },
      { name: 'Development', group: 'started', color: '#22c55e', order: 3 },
      { name: 'Done', group: 'completed', color: '#16a34a', order: 4 },
    ],
    labels: [
      { name: 'bug', color: '#dc2626' },
      { name: 'feature', color: '#16a34a' },
    ],
    identities: [
      {
        role: 'developer-agent',
        email: 'developer-agent@slonk.local',
        first_name: 'Developer',
        last_name: 'Agent',
        default_state: 'Development',
      },
      {
        role: 'qa-agent',
        email: 'qa-agent@slonk.local',
        first_name: 'QA',
        last_name: 'Agent',
        default_state: 'Done',
      },
    ],
  };
}

interface FakeWorld {
  workspaces: PlaneWorkspace[];
  projects: PlaneProject[];
  states: Map<string, PlaneState[]>;
  labels: Map<string, PlaneLabel[]>;
  members: Map<string, PlaneUser[]>;
  inviteResponses: Map<string, { id: string; email: string } | Error>;
}

function newWorld(): FakeWorld {
  return {
    workspaces: [],
    projects: [],
    states: new Map(),
    labels: new Map(),
    members: new Map(),
    inviteResponses: new Map(),
  };
}

function fakePlane(world: FakeWorld): PlaneClient {
  let id = 1;
  const nextId = (prefix: string): string => `${prefix}-${id++}`;
  const stub = {
    async getWorkspaceBySlug(slug: string): Promise<PlaneWorkspace | undefined> {
      return world.workspaces.find((w) => w.slug === slug);
    },
    async createWorkspace(input: { name: string; slug: string }): Promise<PlaneWorkspace> {
      const w: PlaneWorkspace = { id: nextId('ws'), name: input.name, slug: input.slug, owner: 'me' };
      world.workspaces.push(w);
      return w;
    },
    async getProjectByIdentifier(_ws: string, identifier: string): Promise<PlaneProject | undefined> {
      return world.projects.find((p) => p.identifier === identifier);
    },
    async createProject(
      ws: string,
      input: { name: string; identifier: string },
    ): Promise<PlaneProject> {
      const p: PlaneProject = {
        id: nextId('pr'),
        name: input.name,
        identifier: input.identifier,
        workspace: ws,
      };
      world.projects.push(p);
      world.states.set(p.id, []);
      world.labels.set(p.id, []);
      return p;
    },
    async listStates(_ws: string, projectId: string): Promise<PlaneState[]> {
      return world.states.get(projectId) ?? [];
    },
    async createState(
      ws: string,
      projectId: string,
      input: { name: string; color: string; group: PlaneState['group']; sequence?: number; default?: boolean },
    ): Promise<PlaneState> {
      const s: PlaneState = {
        id: nextId('st'),
        name: input.name,
        color: input.color,
        group: input.group,
        sequence: input.sequence ?? 0,
        default: input.default ?? false,
        project: projectId,
        workspace: ws,
      };
      world.states.get(projectId)!.push(s);
      return s;
    },
    async listLabels(_ws: string, projectId: string): Promise<PlaneLabel[]> {
      return world.labels.get(projectId) ?? [];
    },
    async createLabel(
      ws: string,
      projectId: string,
      input: { name: string; color: string },
    ): Promise<PlaneLabel> {
      const l: PlaneLabel = {
        id: nextId('lb'),
        name: input.name,
        color: input.color,
        project: projectId,
        workspace: ws,
      };
      world.labels.get(projectId)!.push(l);
      return l;
    },
    async listWorkspaceMembers(slug: string): Promise<PlaneUser[]> {
      return world.members.get(slug) ?? [];
    },
    async inviteWorkspaceMember(slug: string, input: { email: string }) {
      const resp = world.inviteResponses.get(input.email);
      if (resp instanceof Error) throw resp;
      if (resp !== undefined) {
        const arr = world.members.get(slug) ?? [];
        arr.push({ id: resp.id, email: resp.email });
        world.members.set(slug, arr);
        return resp;
      }
      const generated = { id: nextId('usr'), email: input.email };
      const arr = world.members.get(slug) ?? [];
      arr.push({ id: generated.id, email: generated.email });
      world.members.set(slug, arr);
      return generated;
    },
    // Невостребованные методы — заглушки, чтобы тип PlaneClient совпал.
    async listWorkspaces() {
      return world.workspaces;
    },
    async listProjects(_ws: string) {
      return world.projects;
    },
    async listCycles(): Promise<PlaneCycle[]> {
      return [];
    },
    async listModules(): Promise<PlaneModule[]> {
      return [];
    },
    async listIssues(): Promise<PlaneIssue[]> {
      return [];
    },
    async checkHealth() {
      return { reachable: true, status: 200, latencyMs: 1 };
    },
  } as unknown as PlaneClient;
  return stub;
}

describe('runBootstrap', () => {
  let store: IdentityStore;
  beforeEach(() => {
    store = new IdentityStore({ path: ':memory:' });
  });

  // Plane v1.3.0 API tokens are workspace-scoped — workspace must already
  // exist in Plane before bootstrap. Helper seeds the manifest workspace
  // into the fake world to mirror the real-world precondition.
  function seedWorkspace(world: FakeWorld, manifest: Manifest): void {
    world.workspaces.push({
      id: 'ws-seed',
      slug: manifest.workspace.slug,
      name: manifest.workspace.name,
      owner: 'me',
    });
  }

  it('creates project/states/labels on workspace seeded via UI (per_user)', async () => {
    const world = newWorld();
    const manifest = makeManifest();
    seedWorkspace(world, manifest);
    const plane = fakePlane(world);
    const r = await runBootstrap({
      plane,
      store,
      logger: silentLogger,
      manifest,
      config: { MCP_AGENT_IDENTITY_MODE: 'per_user' },
    });

    expect(r.workspace.created).toBe(false);
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0]?.created).toBe(true);
    expect(r.states.created).toBe(4);
    expect(r.states.existing).toBe(0);
    expect(r.labels.created).toBe(2);
    expect(r.identities.mode).toBe('per_user');
    expect(r.identities.invited).toBe(2);
    expect(store.get('developer-agent')?.mode).toBe('per_user');
    expect(store.get('developer-agent')?.plane_user_id).toMatch(/^usr-/);
  });

  it('is idempotent on second run (no creates, identities skipped)', async () => {
    const world = newWorld();
    const manifest = makeManifest();
    seedWorkspace(world, manifest);
    const plane = fakePlane(world);
    await runBootstrap({
      plane,
      store,
      logger: silentLogger,
      manifest,
      config: { MCP_AGENT_IDENTITY_MODE: 'per_user' },
    });
    const second = await runBootstrap({
      plane,
      store,
      logger: silentLogger,
      manifest,
      config: { MCP_AGENT_IDENTITY_MODE: 'per_user' },
    });
    expect(second.workspace.created).toBe(false);
    expect(second.projects[0]?.created).toBe(false);
    expect(second.states.created).toBe(0);
    expect(second.states.existing).toBe(4);
    expect(second.labels.created).toBe(0);
    expect(second.identities.invited).toBe(0);
    expect(second.identities.skipped).toBe(2);
  });

  it('falls back to single_bot when invite throws', async () => {
    const world = newWorld();
    world.inviteResponses.set('developer-agent@slonk.local', new Error('invitations endpoint forbidden'));
    const manifest = makeManifest();
    seedWorkspace(world, manifest);
    const plane = fakePlane(world);
    const r = await runBootstrap({
      plane,
      store,
      logger: silentLogger,
      manifest,
      config: { MCP_AGENT_IDENTITY_MODE: 'per_user' },
    });
    expect(r.identities.mode).toBe('single_bot');
    expect(r.identities.fallback_reason).toMatch(/invitations endpoint forbidden/);
    expect(store.get('developer-agent')?.mode).toBe('single_bot');
    expect(store.get('developer-agent')?.plane_user_id).toBeNull();
    expect(store.getMeta('identity_mode')).toBe('single_bot');
  });

  it('honours MCP_AGENT_IDENTITY_MODE=single_bot without trying invites', async () => {
    const world = newWorld();
    // если будут попытки invite — не подложен ответ; но мы вообще не должны
    // дойти до этого пути.
    const manifest = makeManifest();
    seedWorkspace(world, manifest);
    const plane = fakePlane(world);
    const r = await runBootstrap({
      plane,
      store,
      logger: silentLogger,
      manifest,
      config: { MCP_AGENT_IDENTITY_MODE: 'single_bot' },
    });
    expect(r.identities.mode).toBe('single_bot');
    expect(r.identities.invited).toBe(0);
    expect(world.members.get('agents') ?? []).toHaveLength(0);
  });

  it('fails with actionable error when workspace was not pre-created in UI', async () => {
    const world = newWorld();
    // intentionally not calling seedWorkspace — simulating the user
    // running bootstrap before creating the workspace in Plane UI.
    const plane = fakePlane(world);
    const manifest = makeManifest();
    await expect(
      runBootstrap({
        plane,
        store,
        logger: silentLogger,
        manifest,
        config: { MCP_AGENT_IDENTITY_MODE: 'per_user' },
      }),
    ).rejects.toThrow(/workspace-scoped/i);
  });
});
