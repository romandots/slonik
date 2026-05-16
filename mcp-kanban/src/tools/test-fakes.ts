// Helpers для тестов read- и write-tool'ов: фейковый PlaneClient с
// in-memory состоянием. Намеренно типизирован как PlaneClient (cast через
// unknown), чтобы тесты получали тот же контракт, что и production-код.

import type {
  PlaneClient,
  PlaneComment,
  PlaneCycle,
  PlaneIssue,
  PlaneIssueActivity,
  PlaneLabel,
  PlaneModule,
  PlaneProject,
  PlaneState,
  PlaneUser,
  PlaneWorkspace,
} from '../plane-client.js';

export interface FakeWorld {
  workspaces: PlaneWorkspace[];
  projects: PlaneProject[];
  states: Map<string, PlaneState[]>;
  labels: Map<string, PlaneLabel[]>;
  cycles: Map<string, PlaneCycle[]>;
  modules: Map<string, PlaneModule[]>;
  issues: Map<string, PlaneIssue[]>;
  activities: Map<string, PlaneIssueActivity[]>;
  comments: Map<string, PlaneComment[]>;
  members: Map<string, PlaneUser[]>;
  /** Очерёдность инвайт-ответов: при .pop() возвращает следующий. */
  inviteResponses: Map<string, { id: string; email: string } | Error>;
  /** Счётчик инкрементальных id для seed данных. */
  nextId: number;
}

export function newWorld(): FakeWorld {
  return {
    workspaces: [],
    projects: [],
    states: new Map(),
    labels: new Map(),
    cycles: new Map(),
    modules: new Map(),
    issues: new Map(),
    activities: new Map(),
    comments: new Map(),
    members: new Map(),
    inviteResponses: new Map(),
    nextId: 1,
  };
}

export function seedAgentsWorkspace(world: FakeWorld): {
  workspace: PlaneWorkspace;
  project: PlaneProject;
  states: PlaneState[];
  labels: PlaneLabel[];
} {
  const workspace: PlaneWorkspace = {
    id: 'ws-agents',
    name: 'Code Agents',
    slug: 'agents',
    owner: 'me',
  };
  world.workspaces.push(workspace);
  const project: PlaneProject = {
    id: 'pr-1',
    name: 'Code Agents',
    identifier: 'SLONK',
    workspace: workspace.id,
  };
  world.projects.push(project);
  const states: PlaneState[] = [
    mkState(project, 'Backlog', 'backlog', '#94a3b8', 1, true),
    mkState(project, 'To Do', 'unstarted', '#3b82f6', 2),
    mkState(project, 'Development', 'started', '#22c55e', 3),
    mkState(project, 'Done', 'completed', '#16a34a', 4),
  ];
  world.states.set(project.id, states);
  const labels: PlaneLabel[] = [
    mkLabel(project, 'bug', '#dc2626'),
    mkLabel(project, 'feature', '#16a34a'),
    mkLabel(project, 'agent-claimed', '#22c55e'),
    mkLabel(project, 'needs-human', '#ef4444'),
  ];
  world.labels.set(project.id, labels);
  world.cycles.set(project.id, []);
  world.modules.set(project.id, []);
  world.issues.set(project.id, []);
  return { workspace, project, states, labels };
}

function mkState(
  p: PlaneProject,
  name: string,
  group: PlaneState['group'],
  color: string,
  order: number,
  isDefault = false,
): PlaneState {
  return {
    id: `st-${name}`,
    name,
    group,
    color,
    sequence: order * 1000,
    default: isDefault,
    project: p.id,
    workspace: p.workspace,
  };
}

function mkLabel(p: PlaneProject, name: string, color: string): PlaneLabel {
  return {
    id: `lb-${name}`,
    name,
    color,
    project: p.id,
    workspace: p.workspace,
  };
}

export function addIssue(
  world: FakeWorld,
  projectId: string,
  data: Partial<PlaneIssue> & { name: string; state: string },
): PlaneIssue {
  const arr = world.issues.get(projectId) ?? [];
  const seq = arr.length + 1;
  // Plane v1.3.0 хранит тело задачи в `description_html` (TipTap), а поле
  // `description` тихо игнорирует. Фейк должен моделировать ту же
  // семантику, иначе тесты read-тулов прятали бы регрессии. Для удобства
  // тестов, которые передают `description: "..."`, миксуем значение в
  // `description_html` (а не в отдельное поле), чтобы `getIssue` его нашёл.
  const seededHtml =
    data.description_html ??
    data.description ??
    undefined;
  const issue: PlaneIssue = {
    id: data.id ?? `iss-${world.nextId++}`,
    name: data.name,
    state: data.state,
    priority: data.priority ?? null,
    assignees: data.assignees ?? [],
    labels: data.labels ?? [],
    project: projectId,
    workspace: world.workspaces[0]?.id ?? '',
    sequence_id: data.sequence_id ?? seq,
    ...(seededHtml !== undefined ? { description_html: seededHtml } : {}),
    ...(data.created_at !== undefined ? { created_at: data.created_at } : { created_at: new Date(2026, 0, seq).toISOString() }),
    ...(data.updated_at !== undefined ? { updated_at: data.updated_at } : { updated_at: new Date(2026, 0, seq).toISOString() }),
    ...(data.cycle !== undefined ? { cycle: data.cycle } : {}),
    ...(data.module !== undefined ? { module: data.module } : {}),
    ...(data.parent !== undefined ? { parent: data.parent } : {}),
  };
  arr.push(issue);
  world.issues.set(projectId, arr);
  return issue;
}

export function fakePlane(world: FakeWorld): PlaneClient {
  let counter = 1000;
  const id = (prefix: string): string => `${prefix}-${counter++}`;
  const stub = {
    async checkHealth() {
      return { reachable: true, status: 200, latencyMs: 1 };
    },
    async listWorkspaces() {
      return [...world.workspaces];
    },
    async getWorkspaceBySlug(slug: string) {
      return world.workspaces.find((w) => w.slug === slug);
    },
    async createWorkspace(input: { name: string; slug: string }) {
      const w: PlaneWorkspace = { id: id('ws'), name: input.name, slug: input.slug, owner: 'me' };
      world.workspaces.push(w);
      return w;
    },
    async listProjects(_ws: string) {
      return [...world.projects];
    },
    async getProjectByIdentifier(_ws: string, identifier: string) {
      return world.projects.find((p) => p.identifier === identifier);
    },
    async createProject(ws: string, input: { name: string; identifier: string }) {
      const p: PlaneProject = {
        id: id('pr'),
        name: input.name,
        identifier: input.identifier,
        workspace: ws,
      };
      world.projects.push(p);
      world.states.set(p.id, []);
      world.labels.set(p.id, []);
      world.cycles.set(p.id, []);
      world.modules.set(p.id, []);
      world.issues.set(p.id, []);
      return p;
    },
    async listStates(_ws: string, projectId: string) {
      return [...(world.states.get(projectId) ?? [])];
    },
    async createState(ws: string, projectId: string, input: { name: string; color: string; group: PlaneState['group']; sequence?: number; default?: boolean }) {
      const s: PlaneState = {
        id: id('st'),
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
    async updateState(
      _ws: string,
      projectId: string,
      stateId: string,
      patch: Partial<Pick<PlaneState, 'name' | 'color' | 'group' | 'sequence' | 'default'>>,
    ) {
      const arr = world.states.get(projectId) ?? [];
      const idx = arr.findIndex((s) => s.id === stateId);
      if (idx === -1) {
        const { PlaneError } = await import('../errors.js');
        throw new PlaneError({
          message: `Plane API PATCH states/${stateId}/ failed: 404 not found`,
          planeStatus: 404,
        });
      }
      const next = { ...arr[idx]!, ...patch };
      arr[idx] = next;
      return next;
    },
    async deleteState(_ws: string, projectId: string, stateId: string) {
      const arr = world.states.get(projectId) ?? [];
      const idx = arr.findIndex((s) => s.id === stateId);
      if (idx !== -1) arr.splice(idx, 1);
    },
    async listLabels(_ws: string, projectId: string) {
      return [...(world.labels.get(projectId) ?? [])];
    },
    async createLabel(ws: string, projectId: string, input: { name: string; color: string }) {
      const l: PlaneLabel = {
        id: id('lb'),
        name: input.name,
        color: input.color,
        project: projectId,
        workspace: ws,
      };
      world.labels.get(projectId)!.push(l);
      return l;
    },
    async listCycles(_ws: string, projectId: string) {
      return [...(world.cycles.get(projectId) ?? [])];
    },
    async listModules(_ws: string, projectId: string) {
      return [...(world.modules.get(projectId) ?? [])];
    },
    async listIssues(_ws: string, projectId: string, filter?: Parameters<PlaneClient['listIssues']>[2]) {
      let arr = world.issues.get(projectId) ?? [];
      if (filter?.state !== undefined) {
        const wanted = Array.isArray(filter.state) ? filter.state : filter.state.split(',');
        arr = arr.filter((i) => wanted.includes(i.state));
      }
      if (filter?.labels !== undefined) {
        const wanted = Array.isArray(filter.labels) ? filter.labels : filter.labels.split(',');
        arr = arr.filter((i) => i.labels.some((l) => wanted.includes(l)));
      }
      if (filter?.search !== undefined) {
        const q = filter.search.toLowerCase();
        arr = arr.filter((i) => i.name.toLowerCase().includes(q));
      }
      if (filter?.priority !== undefined) {
        const wanted = Array.isArray(filter.priority) ? filter.priority : filter.priority.split(',');
        arr = arr.filter((i) => i.priority !== null && wanted.includes(i.priority));
      }
      if (filter?.limit !== undefined) arr = arr.slice(0, filter.limit);
      return arr;
    },
    async getIssue(_ws: string, projectId: string, issueId: string) {
      return world.issues.get(projectId)?.find((i) => i.id === issueId);
    },
    async getIssueBySequenceId(_ws: string, projectId: string, _identifier: string, seq: number) {
      return world.issues.get(projectId)?.find((i) => i.sequence_id === seq);
    },
    async createIssue(
      ws: string,
      projectId: string,
      input: {
        name: string;
        state?: string;
        description?: string;
        description_html?: string;
        labels?: string[];
        assignees?: string[];
        priority?: string;
      },
    ) {
      const arr = world.issues.get(projectId) ?? [];
      const seq = arr.length + 1;
      const fallbackState = world.states.get(projectId)?.[0]?.id ?? 'st-Backlog';
      // Plane v1.3.0 пишет тело в `description_html`; параметр `description`
      // сервер игнорирует. Моделируем то же в фейке: сохраняем только
      // `description_html`. Если тест случайно передал legacy `description` —
      // ОТБРАСЫВАЕМ его, как это сделает реальный Plane (это и ловит баг
      // в `create-issue/handler.ts`, если кто-то снова отправит не то поле).
      // Также эмулируем TipTap-санитайзер: вырезаем HTML-комментарии и
      // оборачиваем результат в внешний <div>...</div> — без этого
      // регрессии вида «meta-marker пропал после round-trip» (SLONK-7)
      // ловились бы только в живом Plane.
      const sanitizedHtml =
        input.description_html !== undefined
          ? simulateTipTap(input.description_html)
          : undefined;
      const issue: PlaneIssue = {
        id: id('iss'),
        name: input.name,
        state: input.state ?? fallbackState,
        priority: (input.priority as PlaneIssue['priority']) ?? null,
        assignees: input.assignees ?? [],
        labels: input.labels ?? [],
        project: projectId,
        workspace: ws,
        sequence_id: seq,
        ...(sanitizedHtml !== undefined ? { description_html: sanitizedHtml } : {}),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      arr.push(issue);
      world.issues.set(projectId, arr);
      return issue;
    },
    async updateIssue(
      _ws: string,
      projectId: string,
      issueId: string,
      patch: Partial<PlaneIssue>,
    ) {
      const arr = world.issues.get(projectId) ?? [];
      const idx = arr.findIndex((i) => i.id === issueId);
      if (idx === -1) {
        const { PlaneError } = await import('../errors.js');
        throw new PlaneError({
          message: `Plane API PATCH issues/${issueId}/ failed: 404 not found`,
          planeStatus: 404,
        });
      }
      // Та же семантика, что и в `createIssue`: поле `description` Plane
      // игнорирует — выкидываем из патча. `description_html` прогоняем
      // через TipTap-симулятор (см. createIssue).
      const { description: _ignoredDescription, ...sanePatch } = patch as Partial<PlaneIssue> & {
        description?: string;
      };
      void _ignoredDescription;
      const finalPatch: typeof sanePatch =
        sanePatch.description_html !== undefined
          ? { ...sanePatch, description_html: simulateTipTap(sanePatch.description_html) }
          : sanePatch;
      const next = { ...arr[idx]!, ...finalPatch, updated_at: new Date().toISOString() };
      arr[idx] = next;
      return next;
    },
    async listIssueActivity(_ws: string, projectId: string, issueId: string) {
      return [...(world.activities.get(`${projectId}:${issueId}`) ?? [])];
    },
    async listIssueComments(_ws: string, projectId: string, issueId: string) {
      return [...(world.comments.get(`${projectId}:${issueId}`) ?? [])];
    },
    async createIssueComment(_ws: string, projectId: string, issueId: string, input: { comment_html: string }) {
      const key = `${projectId}:${issueId}`;
      const arr = world.comments.get(key) ?? [];
      const c: PlaneComment = {
        id: id('cm'),
        actor: 'fake-actor',
        comment_html: input.comment_html,
        comment_stripped: stripTags(input.comment_html),
        created_at: new Date().toISOString(),
      };
      arr.push(c);
      world.comments.set(key, arr);
      return c;
    },
    async listWorkspaceMembers(slug: string) {
      return [...(world.members.get(slug) ?? [])];
    },
    async inviteWorkspaceMember(slug: string, input: { email: string }) {
      const resp = world.inviteResponses.get(input.email);
      if (resp instanceof Error) throw resp;
      const out = resp ?? { id: id('usr'), email: input.email };
      const arr = world.members.get(slug) ?? [];
      arr.push({ id: out.id, email: out.email });
      world.members.set(slug, arr);
      return out;
    },
  } as unknown as PlaneClient;
  return stub;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').trim();
}

/**
 * Эмулятор того, что Plane v1.3.0 TipTap-санитайзер делает с
 * `description_html` при сохранении. Покрывает наблюдаемые в проде
 * трансформации (см. SLONK-7 smoke):
 *   1. HTML-комментарии `<!-- ... -->` ВЫРЕЗАЮТСЯ (это и сломало
 *      legacy `<!-- slonk:meta v1 -->` маркер).
 *   2. Весь результат заворачивается в внешний `<div>...</div>`.
 *   3. `<br />` нормализуется до `<br>` (некритично, но соответствует
 *      проду).
 * Поведение упрощённое; реальный TipTap делает больше (нормализация
 * атрибутов, drop unknown tags), но для регрессий вокруг meta-блока
 * этого достаточно — добавляй по мере необходимости.
 */
export function simulateTipTap(html: string): string {
  if (html.length === 0) return '';
  // 1. Strip HTML comments.
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
  // 2. Normalize self-closing <br /> to <br>.
  const normalized = noComments.replace(/<br\s*\/>/g, '<br>');
  // 3. Wrap in <div>...</div> (Plane всегда это делает на чтение).
  // Если вход уже начинается с <div>...</div>, не оборачиваем повторно —
  // тест может передать уже-обёрнутый html, эмулятор должен быть идемпотентен.
  if (/^<div\b/.test(normalized.trimStart()) && /<\/div>\s*$/.test(normalized.trimEnd())) {
    return normalized;
  }
  return `<div>${normalized}</div>`;
}
