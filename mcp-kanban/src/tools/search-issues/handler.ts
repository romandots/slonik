import type { PlaneClient } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import { resolveProject } from '../project-resolver.js';
import {
  DEFAULT_LIMIT,
  keyOf,
  loadLabels,
  loadStates,
  pageFetcher,
  summarise,
  type IssueSummary,
} from '../list-issues/handler.js';
import { issueMatches } from '../list-issues/filter.js';
import { scanIssues } from '../list-issues/scan.js';

export interface SearchIssuesResult {
  workspace: string;
  project: { id: string; identifier: string };
  query: string;
  issues: IssueSummary[];
  next_cursor?: string;
  has_more: boolean;
  scanned: number;
}

/**
 * Полнотекстовый поиск по задачам проекта.
 *
 * SLONK-37: раньше запрос уезжал в Plane параметром `search`, который тот
 * игнорировал — поиск на любую строку возвращал последние N карточек доски,
 * то есть проверка на дубликат перед заведением задачи всегда «ничего не
 * находила». Теперь совпадение считается здесь: по заголовку, ключу
 * (`SLONK-37`) и телу задачи без HTML-разметки.
 */
export async function searchIssues(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  query: string;
  limit?: number;
  cursor?: string;
  projectRef?: string;
}): Promise<SearchIssuesResult> {
  const project = await resolveProject({
    plane: deps.plane,
    workspaceSlug: deps.workspace,
    ...(deps.projectRef !== undefined ? { projectRef: deps.projectRef } : {}),
    defaultProjectRef: deps.defaultProjectRef,
  });

  const needle = deps.query.trim().toLowerCase();
  const scan = await scanIssues({
    plane: deps.plane,
    workspace: deps.workspace,
    projectId: project.id,
    limit: deps.limit ?? DEFAULT_LIMIT,
    ...(deps.cursor !== undefined ? { cursor: deps.cursor } : {}),
    fetchPage: pageFetcher(deps, project.id),
    match: (issue) => issueMatches(issue, { query: needle }, keyOf(issue, project.identifier)),
  });

  const [states, labels] = await Promise.all([
    loadStates(deps, project.id),
    loadLabels(deps, project.id),
  ]);

  return {
    workspace: deps.workspace,
    project: { id: project.id, identifier: project.identifier },
    query: deps.query,
    issues: scan.issues.map((i) => summarise(i, states, labels, project.identifier)),
    ...(scan.nextCursor !== undefined ? { next_cursor: scan.nextCursor } : {}),
    has_more: scan.nextCursor !== undefined,
    scanned: scan.scanned,
  };
}
