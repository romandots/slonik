import type { PlaneClient, PlaneIssue } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import type { AgentIdentity } from '../../identity.js';
import { resolveProject } from '../project-resolver.js';
import { parseIssueRef } from '../get-issue/schema.js';
import { summarise, type IssueSummary } from '../list-issues/handler.js';
import { resolveStateRef } from '../create-issue/handler.js';
import { resolveIssueId } from '../update-issue/handler.js';
import { formatComment } from '../comment-issue/handler.js';
import type { TransitionIssueInput } from './schema.js';

export async function transitionIssue(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  allowedProjects: string[];
  identity: AgentIdentity;
  input: TransitionIssueInput;
}): Promise<IssueSummary> {
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
    allowedProjects: deps.allowedProjects,
  });

  const issueId = await resolveIssueId(deps.plane, deps.workspace, project, parsed);
  const [states, labels] = await Promise.all([
    deps.plane.listStates(deps.workspace, project.id),
    deps.plane.listLabels(deps.workspace, project.id),
  ]);

  const stateId = resolveStateRef(deps.input.state, states);
  const updated = (await deps.plane.updateIssue(deps.workspace, project.id, issueId, {
    state: stateId,
  })) as PlaneIssue;

  if (deps.input.comment !== undefined && deps.input.comment.length > 0) {
    await deps.plane.createIssueComment(deps.workspace, project.id, issueId, {
      comment_html: formatComment(deps.identity, deps.input.comment),
    });
  }
  deps.cache.clear();
  return summarise(updated, states, labels, project.identifier);
}
