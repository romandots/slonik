import type {
  PlaneClient,
  PlaneIssue,
  PlaneIssueActivity,
  PlaneComment,
} from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import { inputHash } from '../../cache.js';
import { McpError } from '../../errors.js';
import { parseIssueRef } from '../get-issue/schema.js';
import { resolveProject } from '../project-resolver.js';

export interface HistoryEntry {
  ts: string;
  kind: 'activity' | 'comment';
  actor: string;
  /** activity-only */
  verb?: string;
  field?: string | null;
  old_value?: string | null;
  new_value?: string | null;
  /** comment-only */
  comment_html?: string;
  comment_text?: string;
  id: string;
}

export interface GetIssueHistoryResult {
  workspace: string;
  project: { id: string; identifier: string };
  issue_id: string;
  entries: HistoryEntry[];
}

export async function getIssueHistory(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  allowedProjects: string[];
  issueRef: string;
  projectRef?: string;
}): Promise<GetIssueHistoryResult> {
  const parsed = parseIssueRef(deps.issueRef);
  const project = await resolveProject({
    plane: deps.plane,
    workspaceSlug: deps.workspace,
    ...(deps.projectRef !== undefined
      ? { projectRef: deps.projectRef }
      : parsed.kind === 'sequence' && parsed.identifier !== undefined
        ? { projectRef: parsed.identifier }
        : {}),
    defaultProjectRef: deps.defaultProjectRef,
    allowedProjects: deps.allowedProjects,
  });

  const cacheKey = `get_issue_lookup:${inputHash({ ws: deps.workspace, pr: project.id, ref: deps.issueRef })}`;
  const issue = (await deps.cache.memoize(cacheKey, async () => {
    if (parsed.kind === 'uuid' && parsed.uuid !== undefined) {
      return await deps.plane.getIssue(deps.workspace, project.id, parsed.uuid);
    }
    if (parsed.kind === 'sequence' && parsed.sequence !== undefined) {
      return await deps.plane.getIssueBySequenceId(
        deps.workspace,
        project.id,
        project.identifier,
        parsed.sequence,
      );
    }
    return undefined;
  })) as PlaneIssue | undefined;

  if (issue === undefined) {
    throw new McpError({
      code: 'NOT_FOUND',
      message: `Issue '${deps.issueRef}' not found in ${project.identifier}`,
    });
  }

  const historyKey = `get_issue_history:${inputHash({ ws: deps.workspace, pr: project.id, id: issue.id })}`;
  const { activity, comments } = (await deps.cache.memoize(historyKey, async () => {
    const [activity, comments] = await Promise.all([
      deps.plane.listIssueActivity(deps.workspace, project.id, issue.id),
      deps.plane.listIssueComments(deps.workspace, project.id, issue.id),
    ]);
    return { activity, comments };
  })) as { activity: PlaneIssueActivity[]; comments: PlaneComment[] };

  const entries: HistoryEntry[] = [];
  for (const a of activity) {
    entries.push({
      id: a.id,
      ts: a.created_at,
      kind: 'activity',
      actor: a.actor,
      verb: a.verb,
      field: a.field,
      old_value: a.old_value,
      new_value: a.new_value,
    });
  }
  for (const c of comments) {
    entries.push({
      id: c.id,
      ts: c.created_at,
      kind: 'comment',
      actor: c.actor,
      ...(c.comment_html !== undefined ? { comment_html: c.comment_html } : {}),
      ...(c.comment_stripped !== undefined ? { comment_text: c.comment_stripped } : {}),
    });
  }
  entries.sort((a, b) => a.ts.localeCompare(b.ts));

  return {
    workspace: deps.workspace,
    project: { id: project.id, identifier: project.identifier },
    issue_id: issue.id,
    entries,
  };
}
