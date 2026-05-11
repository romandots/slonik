import type { PlaneClient, PlaneIssue, PlaneLabel, PlaneState } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import { inputHash } from '../../cache.js';
import { resolveProject } from '../project-resolver.js';
import { summarise, type IssueSummary } from '../list-issues/handler.js';

export interface SearchIssuesResult {
  workspace: string;
  project: { id: string; identifier: string };
  query: string;
  issues: IssueSummary[];
}

export async function searchIssues(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  allowedProjects: string[];
  query: string;
  limit?: number;
  projectRef?: string;
}): Promise<SearchIssuesResult> {
  const project = await resolveProject({
    plane: deps.plane,
    workspaceSlug: deps.workspace,
    ...(deps.projectRef !== undefined ? { projectRef: deps.projectRef } : {}),
    defaultProjectRef: deps.defaultProjectRef,
    allowedProjects: deps.allowedProjects,
  });

  const filter: Parameters<PlaneClient['listIssues']>[2] = {
    search: deps.query,
    ...(deps.limit !== undefined ? { limit: deps.limit } : {}),
  };
  const cacheKey = `search_issues:${inputHash({ ws: deps.workspace, pr: project.id, q: deps.query, l: deps.limit })}`;
  const issues = (await deps.cache.memoize(
    cacheKey,
    async () => await deps.plane.listIssues(deps.workspace, project.id, filter),
  )) as PlaneIssue[];

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

  return {
    workspace: deps.workspace,
    project: { id: project.id, identifier: project.identifier },
    query: deps.query,
    issues: issues.map((i) => summarise(i, states, labels, project.identifier)),
  };
}
