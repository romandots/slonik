import type { PlaneClient, PlaneIssue, PlaneState, PlaneLabel } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import { inputHash } from '../../cache.js';
import { resolveProject } from '../project-resolver.js';
import type { ListIssuesInput } from './schema.js';

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
}

export async function listIssues(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  allowedProjects: string[];
  input: ListIssuesInput;
}): Promise<ListIssuesResult> {
  const project = await resolveProject({
    plane: deps.plane,
    workspaceSlug: deps.workspace,
    ...(deps.input.project !== undefined ? { projectRef: deps.input.project } : {}),
    defaultProjectRef: deps.defaultProjectRef,
    allowedProjects: deps.allowedProjects,
  });

  // Резолвим state-name → state-id (Plane фильтрует по uuid'у state'а).
  const [states, labels] = await Promise.all([
    deps.cache.memoize(
      `list_states:${inputHash({ ws: deps.workspace, pr: project.id })}`,
      async () => await deps.plane.listStates(deps.workspace, project.id),
    ) as Promise<PlaneState[]>,
    deps.cache.memoize(
      `list_labels:${inputHash({ ws: deps.workspace, pr: project.id })}`,
      async () => await deps.plane.listLabels(deps.workspace, project.id),
    ) as Promise<PlaneLabel[]>,
  ]);

  const stateFilter = resolveByName(deps.input.state, states);
  const labelFilter = resolveByName(deps.input.label, labels);

  const filter: Parameters<PlaneClient['listIssues']>[2] = {};
  if (stateFilter !== undefined) filter.state = stateFilter;
  if (labelFilter !== undefined) filter.labels = labelFilter;
  if (deps.input.assignee !== undefined) filter.assignees = deps.input.assignee;
  if (deps.input.priority !== undefined) filter.priority = deps.input.priority;
  if (deps.input.cycle !== undefined) filter.cycle = deps.input.cycle;
  if (deps.input.module !== undefined) filter.module = deps.input.module;
  if (deps.input.limit !== undefined) filter.limit = deps.input.limit;

  const cacheKey = `list_issues:${inputHash({ ws: deps.workspace, pr: project.id, ...filter })}`;
  const issues = (await deps.cache.memoize(
    cacheKey,
    async () => await deps.plane.listIssues(deps.workspace, project.id, filter),
  )) as PlaneIssue[];

  return {
    workspace: deps.workspace,
    project: { id: project.id, identifier: project.identifier },
    issues: issues.map((i) => summarise(i, states, labels, project.identifier)),
  };
}

export function summarise(
  i: PlaneIssue,
  states: PlaneState[],
  labels: PlaneLabel[],
  projectIdentifier: string,
): IssueSummary {
  const state = states.find((s) => s.id === i.state);
  const labelById = new Map(labels.map((l) => [l.id, l.name]));
  return {
    id: i.id,
    ...(i.sequence_id !== undefined ? { sequence_id: i.sequence_id } : {}),
    ...(i.sequence_id !== undefined ? { key: `${projectIdentifier}-${i.sequence_id}` } : {}),
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

function resolveByName(
  input: string | string[] | undefined,
  collection: Array<{ id: string; name: string }>,
): string[] | undefined {
  if (input === undefined) return undefined;
  const arr = Array.isArray(input) ? input : [input];
  return arr.map((v) => collection.find((c) => c.name === v)?.id ?? v);
}
