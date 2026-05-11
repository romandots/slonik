import type { PlaneClient, PlaneIssue } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import { resolveProject } from '../project-resolver.js';
import { parseIssueRef } from '../get-issue/schema.js';
import { summarise, type IssueSummary } from '../list-issues/handler.js';
import { resolveLabelRef } from '../create-issue/handler.js';
import type { UpdateIssueInput } from './schema.js';
import { McpError } from '../../errors.js';

export async function updateIssue(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  allowedProjects: string[];
  input: UpdateIssueInput;
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

  const patch: Parameters<PlaneClient['updateIssue']>[3] = {};
  if (deps.input.name !== undefined) patch.name = deps.input.name;
  if (deps.input.description !== undefined) patch.description = deps.input.description;
  if (deps.input.priority !== undefined) patch.priority = deps.input.priority;
  if (deps.input.labels !== undefined) {
    patch.labels = deps.input.labels.map((n) => resolveLabelRef(n, labels));
  }
  if (deps.input.assignees !== undefined) patch.assignees = deps.input.assignees;

  if (Object.keys(patch).length === 0) {
    throw new McpError({ code: 'INVALID_INPUT', message: 'no fields to update' });
  }

  const updated = (await deps.plane.updateIssue(deps.workspace, project.id, issueId, patch)) as PlaneIssue;
  deps.cache.clear();
  return summarise(updated, states, labels, project.identifier);
}

export async function resolveIssueId(
  plane: PlaneClient,
  workspace: string,
  project: { id: string; identifier: string },
  parsed: ReturnType<typeof parseIssueRef>,
): Promise<string> {
  if (parsed.kind === 'uuid' && parsed.uuid !== undefined) return parsed.uuid;
  if (parsed.kind === 'sequence' && parsed.sequence !== undefined) {
    const issue = await plane.getIssueBySequenceId(workspace, project.id, project.identifier, parsed.sequence);
    if (issue === undefined) {
      throw new McpError({ code: 'NOT_FOUND', message: `Issue ${project.identifier}-${parsed.sequence} not found` });
    }
    return issue.id;
  }
  throw new McpError({ code: 'INVALID_INPUT', message: 'cannot resolve issue id' });
}
