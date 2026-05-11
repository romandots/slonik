import type { Logger } from 'pino';
import type { Config } from './config.js';
import { PlaneError } from './errors.js';

// Тонкая обёртка над Plane REST API v1. Контракт сознательно узкий: только
// те эндпоинты, которые реально нужны bootstrap'у и MCP-tool'ам. Все
// сетевые вызовы проходят через единый `request()` с timeout/retry-budget.

export interface PlaneHealth {
  reachable: boolean;
  status: number | null;
  latencyMs: number | null;
  error?: string;
}

export interface PlaneWorkspace {
  id: string;
  name: string;
  slug: string;
  owner: string;
}

export interface PlaneProject {
  id: string;
  name: string;
  identifier: string;
  workspace: string;
  module_view?: boolean;
  cycle_view?: boolean;
  issue_views_view?: boolean;
  page_view?: boolean;
}

export interface PlaneState {
  id: string;
  name: string;
  color: string;
  group: 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled';
  sequence: number;
  default: boolean;
  project: string;
  workspace: string;
}

export interface PlaneLabel {
  id: string;
  name: string;
  color: string;
  project: string;
  workspace: string;
}

export interface PlaneCycle {
  id: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  project: string;
  workspace: string;
}

export interface PlaneModule {
  id: string;
  name: string;
  description?: string;
  status?: string;
  project: string;
  workspace: string;
}

export interface PlaneIssue {
  id: string;
  name: string;
  description_html?: string;
  description?: string;
  state: string;
  priority: 'urgent' | 'high' | 'medium' | 'low' | 'none' | null;
  assignees: string[];
  labels: string[];
  project: string;
  workspace: string;
  sequence_id?: number;
  created_at?: string;
  updated_at?: string;
  parent?: string | null;
  module?: string | null;
  cycle?: string | null;
}

export interface PlaneUser {
  id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  display_name?: string;
}

export interface PlaneIssueActivity {
  id: string;
  actor: string;
  verb: string;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  comment: string | null;
  created_at: string;
}

export interface PlaneComment {
  id: string;
  actor: string;
  comment_html?: string;
  comment_stripped?: string;
  created_at: string;
  updated_at?: string;
}

export interface ListResult<T> {
  results: T[];
  next?: string | null;
  count?: number;
}

export interface ListIssuesFilter {
  state?: string | string[];
  state__name?: string | string[];
  labels?: string | string[];
  assignees?: string | string[];
  cycle?: string;
  module?: string;
  search?: string;
  priority?: string | string[];
  limit?: number;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Если true — 404 не бросает, а возвращает undefined. */
  notFoundOk?: boolean;
}

export class PlaneClient {
  private readonly baseUrl: URL;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly retryAttempts: number;
  private readonly retryBackoffMs: number;
  private readonly log: Logger;

  constructor(opts: {
    config: Pick<
      Config,
      | 'PLANE_API_BASE_URL'
      | 'PLANE_API_KEY'
      | 'MCP_PLANE_TIMEOUT_MS'
      | 'MCP_RETRY_ATTEMPTS'
      | 'MCP_RETRY_BACKOFF_MS'
    >;
    logger: Logger;
  }) {
    this.baseUrl = new URL(opts.config.PLANE_API_BASE_URL);
    if (!this.baseUrl.pathname.endsWith('/')) {
      this.baseUrl.pathname = `${this.baseUrl.pathname}/`;
    }
    this.apiKey = opts.config.PLANE_API_KEY;
    this.timeoutMs = opts.config.MCP_PLANE_TIMEOUT_MS;
    this.retryAttempts = opts.config.MCP_RETRY_ATTEMPTS;
    this.retryBackoffMs = opts.config.MCP_RETRY_BACKOFF_MS;
    this.log = opts.logger.child({ component: 'plane-client' });
  }

  async checkHealth(): Promise<PlaneHealth> {
    // upstream Plane v1.3.0 не отдаёт /api/v1/health; рабочий probe —
    // корень `/` (200 + {status: "OK"}).
    const root = new URL('/', this.baseUrl);
    const t0 = performance.now();
    try {
      const resp = await fetch(root, {
        method: 'GET',
        headers: this.apiKey !== undefined ? { 'X-Api-Key': this.apiKey } : {},
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const latencyMs = Math.round(performance.now() - t0);
      return { reachable: resp.ok, status: resp.status, latencyMs };
    } catch (err) {
      const latencyMs = Math.round(performance.now() - t0);
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn({ err: msg, latencyMs }, 'Plane health probe failed');
      return { reachable: false, status: null, latencyMs, error: msg };
    }
  }

  // ---------------- low-level request ----------------

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (this.apiKey !== undefined) {
      headers['X-Api-Key'] = this.apiKey;
    }
    const init: RequestInit = {
      method: opts.method ?? 'GET',
      headers,
    };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    const method = init.method as string;
    const attempts = this.retryAttempts + 1;
    let lastErr: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const resp = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (resp.status === 404 && opts.notFoundOk === true) {
          return undefined as unknown as T;
        }
        if (!resp.ok) {
          if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
            // retryable
            if (attempt < attempts - 1) {
              await this.sleep(this.backoffMs(attempt));
              continue;
            }
          }
          const text = await safeText(resp);
          throw new PlaneError({
            message: `Plane API ${method} ${path} failed: ${resp.status} ${text.slice(0, 200)}`,
            planeStatus: resp.status,
          });
        }
        if (resp.status === 204) {
          return undefined as unknown as T;
        }
        const ct = resp.headers.get('content-type') ?? '';
        if (!ct.includes('application/json')) {
          return undefined as unknown as T;
        }
        return (await resp.json()) as T;
      } catch (err) {
        lastErr = err;
        if (err instanceof PlaneError) throw err;
        if (attempt < attempts - 1) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new PlaneError({
          message: `Plane API ${method} ${path} unreachable: ${msg}`,
          cause: err,
        });
      }
    }
    // Если бы все попытки исчерпались без throw — это невозможно по
    // конструкции, но TS этого не выводит.
    throw new PlaneError({
      message: `Plane API ${method} ${path} retries exhausted`,
      cause: lastErr,
    });
  }

  private backoffMs(attempt: number): number {
    return this.retryBackoffMs * 2 ** attempt;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((r) => setTimeout(r, ms));
  }

  private buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): URL {
    // path относительный (`workspaces/`, `workspaces/agents/projects/`),
    // склеивается с baseUrl. Если приходит абсолютный — используем как
    // есть (на случай pagination next-URL).
    const url = /^https?:\/\//.test(path) ? new URL(path) : new URL(path, this.baseUrl);
    if (query !== undefined) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url;
  }

  // ---------------- high-level: workspaces ----------------

  async listWorkspaces(): Promise<PlaneWorkspace[]> {
    return await this.request<PlaneWorkspace[]>('workspaces/');
  }

  async getWorkspaceBySlug(slug: string): Promise<PlaneWorkspace | undefined> {
    const all = await this.listWorkspaces();
    return all.find((w) => w.slug === slug);
  }

  async createWorkspace(input: { name: string; slug: string }): Promise<PlaneWorkspace> {
    return await this.request<PlaneWorkspace>('workspaces/', {
      method: 'POST',
      body: input,
    });
  }

  // ---------------- high-level: projects ----------------

  async listProjects(workspaceSlug: string): Promise<PlaneProject[]> {
    return await this.request<PlaneProject[]>(`workspaces/${workspaceSlug}/projects/`);
  }

  async getProjectByIdentifier(
    workspaceSlug: string,
    identifier: string,
  ): Promise<PlaneProject | undefined> {
    const all = await this.listProjects(workspaceSlug);
    return all.find((p) => p.identifier === identifier);
  }

  async createProject(
    workspaceSlug: string,
    input: {
      name: string;
      identifier: string;
      module_view?: boolean;
      cycle_view?: boolean;
      issue_views_view?: boolean;
      page_view?: boolean;
    },
  ): Promise<PlaneProject> {
    return await this.request<PlaneProject>(`workspaces/${workspaceSlug}/projects/`, {
      method: 'POST',
      body: input,
    });
  }

  // ---------------- high-level: states ----------------

  async listStates(workspaceSlug: string, projectId: string): Promise<PlaneState[]> {
    return await this.request<PlaneState[]>(
      `workspaces/${workspaceSlug}/projects/${projectId}/states/`,
    );
  }

  async createState(
    workspaceSlug: string,
    projectId: string,
    input: {
      name: string;
      color: string;
      group: PlaneState['group'];
      sequence?: number;
      default?: boolean;
    },
  ): Promise<PlaneState> {
    return await this.request<PlaneState>(
      `workspaces/${workspaceSlug}/projects/${projectId}/states/`,
      { method: 'POST', body: input },
    );
  }

  // ---------------- high-level: labels ----------------

  async listLabels(workspaceSlug: string, projectId: string): Promise<PlaneLabel[]> {
    return await this.request<PlaneLabel[]>(
      `workspaces/${workspaceSlug}/projects/${projectId}/labels/`,
    );
  }

  async createLabel(
    workspaceSlug: string,
    projectId: string,
    input: { name: string; color: string },
  ): Promise<PlaneLabel> {
    return await this.request<PlaneLabel>(
      `workspaces/${workspaceSlug}/projects/${projectId}/labels/`,
      { method: 'POST', body: input },
    );
  }

  // ---------------- high-level: cycles / modules ----------------

  async listCycles(workspaceSlug: string, projectId: string): Promise<PlaneCycle[]> {
    return await this.request<PlaneCycle[]>(
      `workspaces/${workspaceSlug}/projects/${projectId}/cycles/`,
    );
  }

  async listModules(workspaceSlug: string, projectId: string): Promise<PlaneModule[]> {
    return await this.request<PlaneModule[]>(
      `workspaces/${workspaceSlug}/projects/${projectId}/modules/`,
    );
  }

  // ---------------- high-level: issues ----------------

  async listIssues(
    workspaceSlug: string,
    projectId: string,
    filter: ListIssuesFilter = {},
  ): Promise<PlaneIssue[]> {
    const query: Record<string, string | number | undefined> = {};
    const merge = (k: string, v: string | string[] | undefined): void => {
      if (v === undefined) return;
      query[k] = Array.isArray(v) ? v.join(',') : v;
    };
    merge('state', filter.state);
    merge('state__name', filter.state__name);
    merge('labels', filter.labels);
    merge('assignees', filter.assignees);
    merge('priority', filter.priority);
    if (filter.cycle !== undefined) query['cycle'] = filter.cycle;
    if (filter.module !== undefined) query['module'] = filter.module;
    if (filter.search !== undefined) query['search'] = filter.search;
    if (filter.limit !== undefined) query['per_page'] = filter.limit;

    const resp = await this.request<ListResult<PlaneIssue> | PlaneIssue[]>(
      `workspaces/${workspaceSlug}/projects/${projectId}/issues/`,
      { query },
    );
    return Array.isArray(resp) ? resp : resp.results;
  }

  async getIssue(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
  ): Promise<PlaneIssue | undefined> {
    return await this.request<PlaneIssue>(
      `workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/`,
      { notFoundOk: true },
    );
  }

  async getIssueBySequenceId(
    workspaceSlug: string,
    projectId: string,
    identifier: string,
    sequenceId: number,
  ): Promise<PlaneIssue | undefined> {
    // Plane не отдаёт прямого "lookup by SLONK-123" — фильтруем issues.
    const all = await this.listIssues(workspaceSlug, projectId, { limit: 500 });
    return all.find((i) => i.sequence_id === sequenceId);
  }

  async createIssue(
    workspaceSlug: string,
    projectId: string,
    input: {
      name: string;
      description_html?: string;
      description?: string;
      state?: string;
      priority?: string;
      assignees?: string[];
      labels?: string[];
      parent?: string;
      module?: string;
      cycle?: string;
    },
  ): Promise<PlaneIssue> {
    return await this.request<PlaneIssue>(
      `workspaces/${workspaceSlug}/projects/${projectId}/issues/`,
      { method: 'POST', body: input },
    );
  }

  async updateIssue(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    patch: Partial<{
      name: string;
      description_html: string;
      description: string;
      state: string;
      priority: string;
      assignees: string[];
      labels: string[];
      parent: string | null;
      module: string | null;
      cycle: string | null;
    }>,
  ): Promise<PlaneIssue> {
    return await this.request<PlaneIssue>(
      `workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/`,
      { method: 'PATCH', body: patch },
    );
  }

  // ---------------- high-level: issue activity / comments ----------------

  async listIssueActivity(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
  ): Promise<PlaneIssueActivity[]> {
    const resp = await this.request<ListResult<PlaneIssueActivity> | PlaneIssueActivity[]>(
      `workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/activities/`,
    );
    return Array.isArray(resp) ? resp : resp.results;
  }

  async listIssueComments(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
  ): Promise<PlaneComment[]> {
    const resp = await this.request<ListResult<PlaneComment> | PlaneComment[]>(
      `workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/comments/`,
    );
    return Array.isArray(resp) ? resp : resp.results;
  }

  async createIssueComment(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    input: { comment_html: string },
  ): Promise<PlaneComment> {
    return await this.request<PlaneComment>(
      `workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/comments/`,
      { method: 'POST', body: input },
    );
  }

  // ---------------- high-level: users / members ----------------

  async listWorkspaceMembers(workspaceSlug: string): Promise<PlaneUser[]> {
    // Plane: /workspaces/<slug>/members/ возвращает массив { member: PlaneUser, ... }
    // Различные версии отдают разную форму; нормализуем.
    const raw = await this.request<
      Array<{ member?: PlaneUser; id?: string; email?: string }>
    >(`workspaces/${workspaceSlug}/members/`);
    return raw.map((row) => {
      if (row.member !== undefined) return row.member;
      return {
        id: String(row.id ?? ''),
        email: String(row.email ?? ''),
      };
    });
  }

  async inviteWorkspaceMember(
    workspaceSlug: string,
    input: { email: string; role?: number },
  ): Promise<{ id: string; email: string } | undefined> {
    // В Plane v1.3.0 эндпоинт для invite — POST /workspaces/<slug>/invitations/
    // (форма зависит от версии). Возвращает приглашение/инвайт, не сам user.
    // Bootstrap использует этот вызов в режиме per_user; при ошибке —
    // fallback на single_bot.
    return await this.request<{ id: string; email: string }>(
      `workspaces/${workspaceSlug}/invitations/`,
      {
        method: 'POST',
        body: {
          emails: [{ email: input.email, role: input.role ?? 15 }],
        },
        notFoundOk: true,
      },
    );
  }
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '';
  }
}
