import type { PlaneClient, PlaneIssue, PlaneState, PlaneLabel, PlaneUser } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import { inputHash } from '../../cache.js';
import { McpError } from '../../errors.js';
import { resolveProject } from '../project-resolver.js';
import type { ListIssuesInput } from './schema.js';
import {
  issueMatches,
  resolveAssignees,
  resolveLabels,
  resolvePriorities,
  resolveStates,
  type IssueFilter,
} from './filter.js';
import { PAGE_SIZE, scanIssues } from './scan.js';

/** Сколько задач отдаём, если вызывающий не задал `limit`. */
export const DEFAULT_LIMIT = 50;

export interface IssueSummary {
  id: string;
  sequence_id?: number;
  key?: string;
  name: string;
  state: { id: string; name: string; group: string } | null;
  labels: string[];
  assignees: string[];
  priority: string | null;
  cycle?: string | null;
  module?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ListIssuesResult {
  workspace: string;
  project: { id: string; identifier: string };
  issues: IssueSummary[];
  /** Курсор для следующей страницы; передать обратно в `cursor`. */
  next_cursor?: string;
  /** `true` — доска пройдена не до конца, есть что дочитать по `next_cursor`. */
  has_more: boolean;
  /** Сколько задач проекта просмотрено, чтобы собрать эту выдачу. */
  scanned: number;
}

export async function listIssues(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  input: ListIssuesInput;
}): Promise<ListIssuesResult> {
  const project = await resolveProject({
    plane: deps.plane,
    workspaceSlug: deps.workspace,
    ...(deps.input.project !== undefined ? { projectRef: deps.input.project } : {}),
    defaultProjectRef: deps.defaultProjectRef,
  });

  const [states, labels] = await Promise.all([
    loadStates(deps, project.id),
    loadLabels(deps, project.id),
  ]);

  // Резолв фильтров — здесь же и валидация: неизвестное состояние/приоритет/
  // исполнитель бросают INVALID_INPUT. Тихо вернуть «всё подряд» нельзя:
  // такой ответ неотличим от честного (SLONK-37).
  const filter: IssueFilter = {};
  const stateIds = resolveStates(deps.input.state, states);
  if (stateIds !== undefined) filter.states = stateIds;
  const labelIds = resolveLabels(deps.input.label, labels);
  if (labelIds !== undefined) filter.labels = labelIds;
  const priorities = resolvePriorities(deps.input.priority);
  if (priorities !== undefined) filter.priorities = priorities;
  if (deps.input.assignee !== undefined) {
    const members = await loadMembers(deps);
    const assignees = resolveAssignees(deps.input.assignee, members);
    if (assignees !== undefined) filter.assignees = assignees;
  }
  if (deps.input.cycle !== undefined) filter.cycle = deps.input.cycle;
  if (deps.input.module !== undefined) filter.module = deps.input.module;

  // Plane не обязан отдавать `cycle`/`module` в теле задачи. Если поля нет
  // ни у одной просмотренной задачи, фильтр по нему дал бы пустую выдачу «по
  // техническим причинам» — снова молчаливый отказ. Ловим и говорим прямо.
  let sawCycle = false;
  let sawModule = false;

  const scan = await scanIssues({
    plane: deps.plane,
    workspace: deps.workspace,
    projectId: project.id,
    limit: deps.input.limit ?? DEFAULT_LIMIT,
    ...(deps.input.cursor !== undefined ? { cursor: deps.input.cursor } : {}),
    fetchPage: pageFetcher(deps, project.id),
    match: (issue) => {
      if (issue.cycle !== undefined) sawCycle = true;
      if (issue.module !== undefined) sawModule = true;
      return issueMatches(issue, filter, keyOf(issue, project.identifier));
    },
  });

  if (scan.scanned > 0) {
    assertFieldExposed('cycle', filter.cycle, sawCycle);
    assertFieldExposed('module', filter.module, sawModule);
  }

  return {
    workspace: deps.workspace,
    project: { id: project.id, identifier: project.identifier },
    issues: scan.issues.map((i) => summarise(i, states, labels, project.identifier)),
    ...(scan.nextCursor !== undefined ? { next_cursor: scan.nextCursor } : {}),
    has_more: scan.nextCursor !== undefined,
    scanned: scan.scanned,
  };
}

/**
 * Загрузчик страницы задач.
 *
 * Кешируется только **первая** страница: она горячая (каждый вызов любого
 * read-инструмента начинается с неё), а глубокие страницы читаются разово при
 * обходе доски. Держать их в TTL-кеше значило бы удерживать до тысячи задач с
 * `description_html` на десяток секунд — ровно тот memory pressure, из-за
 * которого в SLONK-5 отказались от выборки `per_page=500`.
 */
export function pageFetcher(
  deps: { plane: PlaneClient; cache: TtlCache; workspace: string },
  projectId: string,
): (cursor: string | undefined) => Promise<{ items: PlaneIssue[]; nextCursor?: string }> {
  return async (cursor) => {
    const fetch = async (): Promise<{ items: PlaneIssue[]; nextCursor?: string }> =>
      await deps.plane.listIssuesPage(deps.workspace, projectId, {
        perPage: PAGE_SIZE,
        ...(cursor !== undefined ? { cursor } : {}),
      });
    if (cursor !== undefined) return await fetch();
    const key = `list_issues_page:${inputHash({ ws: deps.workspace, pr: projectId })}`;
    return (await deps.cache.memoize(key, fetch)) as {
      items: PlaneIssue[];
      nextCursor?: string;
    };
  };
}

export async function loadStates(
  deps: { plane: PlaneClient; cache: TtlCache; workspace: string },
  projectId: string,
): Promise<PlaneState[]> {
  return (await deps.cache.memoize(
    `list_states:${inputHash({ ws: deps.workspace, pr: projectId })}`,
    async () => await deps.plane.listStates(deps.workspace, projectId),
  )) as PlaneState[];
}

export async function loadLabels(
  deps: { plane: PlaneClient; cache: TtlCache; workspace: string },
  projectId: string,
): Promise<PlaneLabel[]> {
  return (await deps.cache.memoize(
    `list_labels:${inputHash({ ws: deps.workspace, pr: projectId })}`,
    async () => await deps.plane.listLabels(deps.workspace, projectId),
  )) as PlaneLabel[];
}

async function loadMembers(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
}): Promise<PlaneUser[]> {
  return (await deps.cache.memoize(
    `list_members:${inputHash({ ws: deps.workspace })}`,
    async () => await deps.plane.listWorkspaceMembers(deps.workspace),
  )) as PlaneUser[];
}

function assertFieldExposed(field: 'cycle' | 'module', value: string | undefined, seen: boolean): void {
  if (value === undefined || seen) return;
  throw new McpError({
    code: 'INVALID_INPUT',
    message:
      `Cannot filter by ${field}: this Plane version does not expose \`${field}\` ` +
      `on the issue payload, so the filter would silently match nothing. ` +
      `Use list_${field}s and the Plane UI instead.`,
  });
}

export function keyOf(issue: PlaneIssue, projectIdentifier: string): string | undefined {
  return issue.sequence_id !== undefined ? `${projectIdentifier}-${issue.sequence_id}` : undefined;
}

export function summarise(
  i: PlaneIssue,
  states: PlaneState[],
  labels: PlaneLabel[],
  projectIdentifier: string,
): IssueSummary {
  const state = states.find((s) => s.id === i.state);
  const labelById = new Map(labels.map((l) => [l.id, l.name]));
  const key = keyOf(i, projectIdentifier);
  return {
    id: i.id,
    ...(i.sequence_id !== undefined ? { sequence_id: i.sequence_id } : {}),
    ...(key !== undefined ? { key } : {}),
    name: i.name,
    state: state !== undefined ? { id: state.id, name: state.name, group: state.group } : null,
    labels: i.labels.map((id) => labelById.get(id) ?? id),
    assignees: i.assignees,
    priority: i.priority,
    ...(i.cycle !== undefined ? { cycle: i.cycle } : {}),
    ...(i.module !== undefined ? { module: i.module } : {}),
    ...(i.created_at !== undefined ? { created_at: i.created_at } : {}),
    ...(i.updated_at !== undefined ? { updated_at: i.updated_at } : {}),
  };
}
