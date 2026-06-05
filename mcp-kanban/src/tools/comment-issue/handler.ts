import type { PlaneClient, PlaneComment } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import type { AgentIdentity } from '../../identity.js';
import { resolveProject } from '../project-resolver.js';
import { parseIssueRef } from '../get-issue/schema.js';
import { resolveIssueId } from '../update-issue/handler.js';
import { sanitizeHtml } from '../../sanitize-html.js';
import type { CommentIssueInput } from './schema.js';

export interface CommentIssueResult {
  comment: PlaneComment;
  issue_id: string;
}

export async function commentIssue(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  identity: AgentIdentity;
  input: CommentIssueInput;
}): Promise<CommentIssueResult> {
  const parsed = parseIssueRef(deps.input.issue_id);
  const project = await resolveProject({
    plane: deps.plane,
    workspaceSlug: deps.workspace,
    ...(deps.input.project !== undefined
      ? { projectRef: deps.input.project }
      : parsed.kind === 'sequence' && parsed.identifier !== undefined
        ? { projectRef: parsed.identifier }
        : {}),
    defaultProjectRef: deps.defaultProjectRef,
  });

  const issueId = await resolveIssueId(deps.plane, deps.workspace, project, parsed);
  const comment = await deps.plane.createIssueComment(deps.workspace, project.id, issueId, {
    comment_html: formatComment(deps.identity, deps.input.comment),
  });
  deps.cache.clear();
  return { comment, issue_id: issueId };
}

/** Все комментарии MCP начинаются с `[<role>]:` (SPEC §5.5). */
export function formatComment(identity: AgentIdentity, body: string): string {
  return `<p><strong>[${identity}]</strong>: ${sanitizeHtml(body)}</p>`;
}

