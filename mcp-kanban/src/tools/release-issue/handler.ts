import type { PlaneClient, PlaneIssue } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import type { AgentIdentity } from '../../identity.js';
import type { AuditLog } from '../../audit.js';
import { McpError } from '../../errors.js';
import { resolveProject } from '../project-resolver.js';
import { parseIssueRef } from '../get-issue/schema.js';
import { resolveIssueId } from '../update-issue/handler.js';
import { resolveStateRef } from '../create-issue/handler.js';
import { summarise, type IssueSummary } from '../list-issues/handler.js';
import { claimedLabelName } from '../claim-issue/handler.js';
import type { ReleaseIssueInput } from './schema.js';

export async function releaseIssue(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  audit: AuditLog;
  workspace: string;
  defaultProjectRef: string;
  allowedProjects: string[];
  identity: AgentIdentity;
  planeUserId: string | null;
  input: ReleaseIssueInput;
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
  const current = deps.audit.currentClaim(issueId);
  if (current === undefined) {
    throw new McpError({
      code: 'CONFLICT',
      message: `Issue ${issueId} is not claimed`,
    });
  }
  if (current.identity !== deps.identity) {
    throw new McpError({
      code: 'CONFLICT',
      message: `Issue ${issueId} is claimed by ${current.identity}, not ${deps.identity}`,
    });
  }

  const released = deps.audit.releaseClaim({ issue_id: issueId, identity: deps.identity });
  if (!released) {
    throw new McpError({ code: 'INTERNAL', message: 'failed to release claim row' });
  }

  const [states, labels] = await Promise.all([
    deps.plane.listStates(deps.workspace, project.id),
    deps.plane.listLabels(deps.workspace, project.id),
  ]);
  const claimedLbl = labels.find((l) => l.name === claimedLabelName());
  const issue = await deps.plane.getIssue(deps.workspace, project.id, issueId);
  if (issue === undefined) {
    throw new McpError({ code: 'NOT_FOUND', message: `Issue ${issueId} not found` });
  }
  const todoState = states.find((s) => s.name === 'To Do');
  const patch: Parameters<PlaneClient['updateIssue']>[3] = {
    labels: claimedLbl !== undefined ? issue.labels.filter((id) => id !== claimedLbl.id) : issue.labels,
    assignees:
      deps.planeUserId !== null ? issue.assignees.filter((a) => a !== deps.planeUserId) : issue.assignees,
  };
  if (todoState !== undefined) patch.state = todoState.id;
  else patch.state = resolveStateRef('To Do', states);

  const updated = (await deps.plane.updateIssue(deps.workspace, project.id, issueId, patch)) as PlaneIssue;
  deps.cache.clear();
  return summarise(updated, states, labels, project.identifier);
}
