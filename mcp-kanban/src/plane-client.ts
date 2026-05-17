import type { Logger } from 'pino';
import type { Config } from './config.js';
import { McpError, PlaneError } from './errors.js';

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

/**
 * Plane v1.3.0: GET /workspaces/<slug>/projects/<pid>/issues/<iid>/issue-attachments/
 *
 * Поля наблюдаемые в реальном ответе:
 *   - `id`             — UUID вложения внутри Plane.
 *   - `attributes`     — embedded объект с `name` (filename), `size` (bytes),
 *                        `type` (mime). Это исторически Plane хранит как
 *                        Django JSONField; форма стабильна для v1.x.
 *   - `asset`          — object_key в bucket `plane-uploads` (без bucket-
 *                        prefix'а). Это то, что MinIO presign забирает.
 *   - `created_at`     — ISO8601 timestamp.
 *   - `created_by`     — UUID пользователя, который аплоадил.
 */
export interface PlaneAttachment {
  id: string;
  attributes: {
    name: string;
    size: number;
    type: string;
  };
  asset: string;
  created_at: string;
  created_by?: string;
}

export interface ListResult<T> {
  results: T[];
  // Plane v1.3.0 шлёт opaque cursor в поле `next_cursor`; более ранние
  // pre-release сборки шлют `next`. Читаем оба, чтобы пагинация работала
  // на обоих API shape'ах (см. также `extractNextCursor`).
  next?: string | null;
  next_cursor?: string | null;
  count?: number;
}

// Plane v1.3.0 оборачивает все list-эндпоинты в pagination-shape
// `{ results: [...], count, total_pages, next_cursor, ... }`. Более ранние
// версии отдавали плоский массив. Принимаем оба варианта.
function unwrapList<T>(resp: T[] | ListResult<T> | { results: T[] }): T[] {
  if (Array.isArray(resp)) return resp;
  return resp.results ?? [];
}

// Plane v1.3.0 называет cursor `next_cursor`; pre-1.3 сборки шлют `next`.
// Возвращаем тот, что непустой, или undefined — это сигнал «страниц больше нет».
function extractNextCursor<T>(resp: ListResult<T>): string | undefined {
  const candidate = resp.next_cursor ?? resp.next;
  if (candidate === undefined || candidate === null || candidate === '') {
    return undefined;
  }
  return candidate;
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

export interface PlaneClientHooks {
  /** Заменяемый sleep для тестов (детерминированный backoff). */
  sleep?: (ms: number) => Promise<void>;
  /** Заменяемый источник джиттера для тестов. По умолчанию Math.random. */
  random?: () => number;
  /** Заменяемый fetch для тестов. По умолчанию глобальный fetch. */
  fetch?: typeof fetch;
  /** Текущее время мс (для измерения total-wait в сообщении об ошибке). */
  now?: () => number;
}

export class PlaneClient {
  private readonly baseUrl: URL;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly retryAttempts: number;
  private readonly retryAttempts429: number;
  private readonly retryBackoffMs: number;
  private readonly log: Logger;
  private readonly hooks: Required<PlaneClientHooks>;

  constructor(opts: {
    config: Pick<
      Config,
      | 'PLANE_API_BASE_URL'
      | 'PLANE_API_KEY'
      | 'MCP_PLANE_TIMEOUT_MS'
      | 'MCP_RETRY_ATTEMPTS'
      | 'MCP_RETRY_ATTEMPTS_429'
      | 'MCP_RETRY_BACKOFF_MS'
    >;
    logger: Logger;
    hooks?: PlaneClientHooks;
  }) {
    this.baseUrl = new URL(opts.config.PLANE_API_BASE_URL);
    if (!this.baseUrl.pathname.endsWith('/')) {
      this.baseUrl.pathname = `${this.baseUrl.pathname}/`;
    }
    this.apiKey = opts.config.PLANE_API_KEY;
    this.timeoutMs = opts.config.MCP_PLANE_TIMEOUT_MS;
    this.retryAttempts = opts.config.MCP_RETRY_ATTEMPTS;
    this.retryAttempts429 = opts.config.MCP_RETRY_ATTEMPTS_429;
    this.retryBackoffMs = opts.config.MCP_RETRY_BACKOFF_MS;
    this.log = opts.logger.child({ component: 'plane-client' });
    this.hooks = {
      sleep: opts.hooks?.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))),
      random: opts.hooks?.random ?? Math.random,
      fetch: opts.hooks?.fetch ?? fetch,
      now: opts.hooks?.now ?? (() => performance.now()),
    };
  }

  async checkHealth(): Promise<PlaneHealth> {
    // upstream Plane v1.3.0 не отдаёт /api/v1/health; рабочий probe —
    // корень `/` (200 + {status: "OK"}).
    const root = new URL('/', this.baseUrl);
    const t0 = this.hooks.now();
    try {
      const resp = await this.hooks.fetch(root, {
        method: 'GET',
        headers: this.apiKey !== undefined ? { 'X-Api-Key': this.apiKey } : {},
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const latencyMs = Math.round(this.hooks.now() - t0);
      return { reachable: resp.ok, status: resp.status, latencyMs };
    } catch (err) {
      const latencyMs = Math.round(this.hooks.now() - t0);
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
    // Раздельные бюджеты: 5xx/сетевые ретраим скромно, 429 — щедро (Plane
    // лимит per-minute, ждать заведомо имеет смысл). Каждый класс ошибки
    // считается своим счётчиком, чтобы серия 429 не съедала бюджет
    // сетевых ретраев и наоборот.
    let attempts5xx = 0;
    let attempts429 = 0;
    const t0 = this.hooks.now();
    for (;;) {
      try {
        const resp = await this.hooks.fetch(url, {
          ...init,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (resp.status === 404 && opts.notFoundOk === true) {
          return undefined as unknown as T;
        }
        if (!resp.ok) {
          if (resp.status === 429) {
            if (attempts429 < this.retryAttempts429) {
              const waitMs = this.retryAfterMs(resp, attempts429);
              this.log.warn(
                { path, attempt: attempts429 + 1, max: this.retryAttempts429, waitMs },
                'Plane 429, backing off',
              );
              await this.hooks.sleep(waitMs);
              attempts429 += 1;
              continue;
            }
            const text = await safeText(resp);
            const elapsedS = ((this.hooks.now() - t0) / 1000).toFixed(1);
            throw new PlaneError({
              message:
                `Plane rate limit exceeded after ${attempts429 + 1} attempts ` +
                `over ${elapsedS}s on ${method} ${path}. Raise ` +
                `PLANE_API_KEY_RATE_LIMIT in .env (e.g. 300/minute) and ` +
                `recreate plane-api, or wait and re-run — bootstrap is ` +
                `idempotent. Plane reply: ${text.slice(0, 200)}`,
              planeStatus: 429,
            });
          }
          if (resp.status >= 500 && resp.status < 600) {
            if (attempts5xx < this.retryAttempts) {
              await this.hooks.sleep(this.backoffMs(attempts5xx));
              attempts5xx += 1;
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
        if (err instanceof PlaneError) throw err;
        if (attempts5xx < this.retryAttempts) {
          await this.hooks.sleep(this.backoffMs(attempts5xx));
          attempts5xx += 1;
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new PlaneError({
          message: `Plane API ${method} ${path} unreachable: ${msg}`,
          cause: err,
        });
      }
    }
  }

  /**
   * Backoff для 5xx/сетевых: exponential, base × 2^attempt.
   */
  private backoffMs(attempt: number): number {
    return this.retryBackoffMs * 2 ** attempt;
  }

  /**
   * Сколько ждать перед следующей попыткой при 429. Уважает заголовок
   * Retry-After (Plane его не всегда шлёт, но если шлёт — принимаем как
   * source of truth: либо целые секунды, либо HTTP-date). Без заголовка
   * — full-jitter exponential backoff поверх MCP_RETRY_BACKOFF_MS, но не
   * меньше 1s и не больше 30s, чтобы серия 429 за разумное время
   * исчерпала минутное окно лимита.
   */
  private retryAfterMs(resp: Response, attempt: number): number {
    const header = resp.headers.get('retry-after');
    if (header !== null) {
      const asInt = Number(header);
      if (Number.isFinite(asInt) && asInt >= 0) {
        return Math.max(0, Math.round(asInt * 1000));
      }
      const asDate = Date.parse(header);
      if (Number.isFinite(asDate)) {
        return Math.max(0, asDate - Date.now());
      }
    }
    const base = this.retryBackoffMs * 2 ** attempt;
    const capped = Math.min(Math.max(base, 1000), 30_000);
    // full-jitter: [0.5×, 1.5×) — рассинхронизирует параллельные клиенты,
    // не делая ожидание абсурдно коротким.
    const jitter = 0.5 + this.hooks.random();
    return Math.round(capped * jitter);
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
    return unwrapList(
      await this.request<PlaneWorkspace[] | ListResult<PlaneWorkspace>>('workspaces/'),
    );
  }

  async getWorkspaceBySlug(slug: string): Promise<PlaneWorkspace | undefined> {
    // Plane v1.3.0 API-токены workspace-scoped: глобальный `GET /workspaces/`
    // отдаёт 404 (эндпоинт доступен только для user-session). Поэтому
    // существование проверяем через любой workspace-scoped под-ресурс —
    // `workspaces/<slug>/projects/` отдаёт 200 при доступном workspace
    // и 404 при отсутствующем. Реальный shape PlaneWorkspace через API-key
    // недоступен — синтезируем минимальный объект (потребителям достаточно
    // slug, остальные поля не читаются за пределами `listWorkspaces`).
    try {
      await this.request<unknown>(`workspaces/${slug}/projects/`);
      return { id: '', name: slug, slug, owner: '' };
    } catch (err) {
      if (err instanceof PlaneError && err.planeStatus === 404) return undefined;
      throw err;
    }
  }

  async createWorkspace(input: { name: string; slug: string }): Promise<PlaneWorkspace> {
    return await this.request<PlaneWorkspace>('workspaces/', {
      method: 'POST',
      body: input,
    });
  }

  // ---------------- high-level: projects ----------------

  async listProjects(workspaceSlug: string): Promise<PlaneProject[]> {
    return unwrapList(
      await this.request<PlaneProject[] | ListResult<PlaneProject>>(
        `workspaces/${workspaceSlug}/projects/`,
      ),
    );
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
    try {
      return await this.request<PlaneProject>(`workspaces/${workspaceSlug}/projects/`, {
        method: 'POST',
        body: input,
      });
    } catch (err) {
      // Plane v1.3.0 не даёт двум проектам в одном workspace носить
      // одинаковый name (`409 "The project name is already taken"`).
      // identifier тоже уникален в workspace. Поднимаем понятную ошибку,
      // вместо общего PLANE_UNAVAILABLE, чтобы bootstrap'а лог сразу
      // подсказывал, что делать.
      if (
        err instanceof PlaneError &&
        err.planeStatus === 409 &&
        /already taken|already exists/i.test(err.message)
      ) {
        throw new McpError({
          code: 'CONFLICT',
          message:
            `Plane refused to create project "${input.name}" (identifier ` +
            `"${input.identifier}"): the name or identifier collides with an ` +
            `existing project in workspace "${workspaceSlug}". Rename the ` +
            `project in bootstrap/manifest.yaml or delete the conflicting ` +
            `project via Plane UI (workspaces/<slug>/projects/<id>/settings/). ` +
            `Plane reply: ${err.message}`,
          cause: err,
        });
      }
      throw err;
    }
  }

  // ---------------- high-level: states ----------------

  async listStates(workspaceSlug: string, projectId: string): Promise<PlaneState[]> {
    return unwrapList(
      await this.request<PlaneState[] | ListResult<PlaneState>>(
        `workspaces/${workspaceSlug}/projects/${projectId}/states/`,
      ),
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

  async updateState(
    workspaceSlug: string,
    projectId: string,
    stateId: string,
    patch: Partial<{
      name: string;
      color: string;
      group: PlaneState['group'];
      sequence: number;
      default: boolean;
    }>,
  ): Promise<PlaneState> {
    return await this.request<PlaneState>(
      `workspaces/${workspaceSlug}/projects/${projectId}/states/${stateId}/`,
      { method: 'PATCH', body: patch },
    );
  }

  async deleteState(workspaceSlug: string, projectId: string, stateId: string): Promise<void> {
    await this.request<void>(
      `workspaces/${workspaceSlug}/projects/${projectId}/states/${stateId}/`,
      { method: 'DELETE' },
    );
  }

  // ---------------- high-level: labels ----------------

  async listLabels(workspaceSlug: string, projectId: string): Promise<PlaneLabel[]> {
    return unwrapList(
      await this.request<PlaneLabel[] | ListResult<PlaneLabel>>(
        `workspaces/${workspaceSlug}/projects/${projectId}/labels/`,
      ),
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
    return unwrapList(
      await this.request<PlaneCycle[] | ListResult<PlaneCycle>>(
        `workspaces/${workspaceSlug}/projects/${projectId}/cycles/`,
      ),
    );
  }

  async listModules(workspaceSlug: string, projectId: string): Promise<PlaneModule[]> {
    return unwrapList(
      await this.request<PlaneModule[] | ListResult<PlaneModule>>(
        `workspaces/${workspaceSlug}/projects/${projectId}/modules/`,
      ),
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
    _identifier: string,
    sequenceId: number,
  ): Promise<PlaneIssue | undefined> {
    // Раньше: один запрос `?per_page=500`, который сериализовал все
    // 500 issue'ов c `description_html` каждый раз, когда агент адресовал
    // задачу как `SLONK-N`. Это и memory-pressure (~10–100 KB на запись),
    // и swap-триггер на маленьком хосте — см. SLONK-5.
    //
    // Теперь: страницы по `LOOKUP_PAGE_SIZE` (50) с early-exit на первой
    // же странице, содержащей нужный sequence_id. В худшем случае
    // (sequence_id у задачи в самом конце) суммарный объём чтения тот же,
    // но в типичном (последняя задача / её соседи — top of recent list)
    // обрывается на первой странице. Plane v1.3.0 сортирует issues
    // `created_at DESC` по умолчанию.
    const PAGE_SIZE = 50;
    const MAX_PAGES = 50; // 50 * 50 = 2500 issue'ов; больше — это уже не
                          // «маленький хост» и нужен real lookup. См. note ниже.
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query: Record<string, string | number | undefined> = {
        per_page: PAGE_SIZE,
      };
      if (cursor !== undefined) query['cursor'] = cursor;
      const resp = await this.request<ListResult<PlaneIssue> | PlaneIssue[]>(
        `workspaces/${workspaceSlug}/projects/${projectId}/issues/`,
        { query },
      );
      const items = Array.isArray(resp) ? resp : resp.results;
      const found = items.find((i) => i.sequence_id === sequenceId);
      if (found !== undefined) return found;
      // Конец списка: либо пустая страница, либо явно нет next-cursor.
      if (items.length === 0) return undefined;
      if (Array.isArray(resp)) return undefined; // legacy non-paginated shape
      // Plane v1.3.0: `next_cursor`; pre-1.3: `next`. Читаем оба.
      const next = extractNextCursor(resp);
      if (next === undefined) return undefined;
      cursor = next;
    }
    // Защитная заглушка — мы намеренно прекращаем сканировать после
    // MAX_PAGES, чтобы не зациклиться на бажном Plane (next === self).
    return undefined;
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

  // ---------------- high-level: issue attachments ----------------

  /**
   * Список UI-attachments задачи (то, что пользователь приложил через Plane
   * UI). v1.3.0 endpoint: `/issues/<id>/issue-attachments/`.
   *
   * Возвращает голый массив (или `{results: [...]}` — оба варианта
   * нормализуем). Если задача не найдена — Plane отдаёт 404, который
   * пробрасывается как `PlaneError → NOT_FOUND` (см. ErrorCode mapping).
   */
  async listIssueAttachments(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
  ): Promise<PlaneAttachment[]> {
    const resp = await this.request<ListResult<PlaneAttachment> | PlaneAttachment[]>(
      `workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/issue-attachments/`,
    );
    return unwrapList(resp);
  }

  // ---------------- high-level: users / members ----------------

  async listWorkspaceMembers(workspaceSlug: string): Promise<PlaneUser[]> {
    // Plane: /workspaces/<slug>/members/ возвращает массив { member: PlaneUser, ... }
    // Различные версии отдают разную форму; нормализуем.
    const raw = unwrapList(
      await this.request<
        | Array<{ member?: PlaneUser; id?: string; email?: string }>
        | ListResult<{ member?: PlaneUser; id?: string; email?: string }>
      >(`workspaces/${workspaceSlug}/members/`),
    );
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
    // В Plane v1.3.0 эндпоинт invite — POST /workspaces/<slug>/invitations/
    // принимает плоский payload { email, role } и возвращает 201 +
    // Invitation-объект (НЕ User). Реальный plane_user_id появится в
    // /members/ только после того, как приглашённый примет инвайт.
    // Ранее клиент слал batch-обёртку { emails: [{...}] }, что для v1.3.0
    // даёт 400 "email: This field is required."
    //
    // Plane не идемпотентен на повторные invites — на уже отправленный
    // адрес отдаёт 400 "Email already invited". Для bootstrap'а это
    // штатный «уже сделано»: возвращаем undefined, чтобы runner не
    // ушёл в single_bot fallback на повторном прогоне.
    try {
      return await this.request<{ id: string; email: string }>(
        `workspaces/${workspaceSlug}/invitations/`,
        {
          method: 'POST',
          body: { email: input.email, role: input.role ?? 15 },
          notFoundOk: true,
        },
      );
    } catch (err) {
      if (
        err instanceof PlaneError &&
        err.planeStatus === 400 &&
        /already invited/i.test(err.message)
      ) {
        return undefined;
      }
      throw err;
    }
  }
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '';
  }
}
