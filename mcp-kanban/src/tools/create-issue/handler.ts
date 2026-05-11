import type { PlaneClient, PlaneIssue, PlaneLabel, PlaneState } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import { resolveProject } from '../project-resolver.js';
import { summarise, type IssueSummary } from '../list-issues/handler.js';
import type { CreateIssueInput } from './schema.js';
import { McpError } from '../../errors.js';

export interface CreateIssueResult extends IssueSummary {
  key: string;
}

export async function createIssue(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  allowedProjects: string[];
  input: CreateIssueInput;
}): Promise<CreateIssueResult> {
  const project = await resolveProject({
    plane: deps.plane,
    workspaceSlug: deps.workspace,
    ...(deps.input.project !== undefined ? { projectRef: deps.input.project } : {}),
    defaultProjectRef: deps.defaultProjectRef,
    allowedProjects: deps.allowedProjects,
  });

  const [states, labels] = await Promise.all([
    deps.plane.listStates(deps.workspace, project.id),
    deps.plane.listLabels(deps.workspace, project.id),
  ]);

  const body: Parameters<PlaneClient['createIssue']>[2] = {
    name: deps.input.name,
  };
  if (deps.input.description !== undefined) body.description = deps.input.description;
  if (deps.input.priority !== undefined) body.priority = deps.input.priority;
  if (deps.input.state !== undefined) {
    const stateId = resolveStateRef(deps.input.state, states);
    body.state = stateId;
  }
  if (deps.input.labels !== undefined) {
    body.labels = deps.input.labels.map((name) => resolveLabelRef(name, labels));
  }
  if (deps.input.assignees !== undefined) body.assignees = deps.input.assignees;

  const created = await deps.plane.createIssue(deps.workspace, project.id, body);

  // Инвалидируем кеш — следующий read увидит свежий issue.
  deps.cache.clear();

  const summary = summarise(created as PlaneIssue, states, labels, project.identifier);
  return {
    ...summary,
    key: `${project.identifier}-${created.sequence_id ?? '?'}`,
  };
}

export function resolveStateRef(ref: string, states: PlaneState[]): string {
  const byId = states.find((s) => s.id === ref);
  if (byId !== undefined) return byId.id;
  const byName = states.find((s) => s.name === ref);
  if (byName !== undefined) return byName.id;
  throw new McpError({ code: 'INVALID_INPUT', message: `Unknown state: ${ref}` });
}

export function resolveLabelRef(ref: string, labels: PlaneLabel[]): string {
  const byId = labels.find((l) => l.id === ref);
  if (byId !== undefined) return byId.id;
  const byName = labels.find((l) => l.name === ref);
  if (byName !== undefined) return byName.id;
  throw new McpError({ code: 'INVALID_INPUT', message: `Unknown label: ${ref}` });
}
