import type { PlaneClient, PlaneIssue } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import type { AgentIdentity } from '../../identity.js';
import { McpError } from '../../errors.js';
import { resolveProject } from '../project-resolver.js';
import { parseIssueRef } from '../get-issue/schema.js';
import { resolveIssueId } from '../update-issue/handler.js';
import { resolveStateRef } from '../create-issue/handler.js';
import { formatComment } from '../comment-issue/handler.js';
import { summarise, type IssueSummary } from '../list-issues/handler.js';
import type { BlockIssueInput } from './schema.js';

const BLOCKED_LABEL = 'agent-blocked';

export async function blockIssue(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  allowedProjects: string[];
  identity: AgentIdentity;
  input: BlockIssueInput;
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
  const blockedLabel = labels.find((l) => l.name === BLOCKED_LABEL);
  if (blockedLabel === undefined) {
    throw new McpError({ code: 'INTERNAL', message: `Label '${BLOCKED_LABEL}' is missing; run bootstrap` });
  }
  const blockedState = resolveStateRef('Blocked', states);

  const issue = await deps.plane.getIssue(deps.workspace, project.id, issueId);
  if (issue === undefined) {
    throw new McpError({ code: 'NOT_FOUND', message: `Issue ${issueId} not found` });
  }

  const updated = (await deps.plane.updateIssue(deps.workspace, project.id, issueId, {
    state: blockedState,
    labels: [...new Set([...issue.labels, blockedLabel.id])],
  })) as PlaneIssue;
  await deps.plane.createIssueComment(deps.workspace, project.id, issueId, {
    comment_html: formatComment(deps.identity, `blocked: ${deps.input.reason}`),
  });

  deps.cache.clear();
  return summarise(updated, states, labels, project.identifier);
}
