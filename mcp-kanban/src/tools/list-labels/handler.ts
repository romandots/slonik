import type { PlaneClient, PlaneLabel } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import { inputHash } from '../../cache.js';
import { resolveProject } from '../project-resolver.js';

export interface ListLabelsResult {
  workspace: string;
  project: { id: string; identifier: string };
  labels: Array<Pick<PlaneLabel, 'id' | 'name' | 'color'>>;
}

export async function listLabels(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  allowedProjects: string[];
  projectRef?: string;
}): Promise<ListLabelsResult> {
  const project = await resolveProject({
    plane: deps.plane,
    workspaceSlug: deps.workspace,
    ...(deps.projectRef !== undefined ? { projectRef: deps.projectRef } : {}),
    defaultProjectRef: deps.defaultProjectRef,
    allowedProjects: deps.allowedProjects,
  });
  const key = `list_labels:${inputHash({ ws: deps.workspace, pr: project.id })}`;
  const labels = (await deps.cache.memoize(
    key,
    async () => await deps.plane.listLabels(deps.workspace, project.id),
  )) as PlaneLabel[];
  return {
    workspace: deps.workspace,
    project: { id: project.id, identifier: project.identifier },
    labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
  };
}
