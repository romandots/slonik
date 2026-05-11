import type { PlaneClient, PlaneState } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import { inputHash } from '../../cache.js';
import { resolveProject } from '../project-resolver.js';

export interface ListStatesResult {
  workspace: string;
  project: { id: string; identifier: string };
  states: Array<Pick<PlaneState, 'id' | 'name' | 'group' | 'color' | 'sequence' | 'default'>>;
}

export async function listStates(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  allowedProjects: string[];
  projectRef?: string;
}): Promise<ListStatesResult> {
  const project = await resolveProject({
    plane: deps.plane,
    workspaceSlug: deps.workspace,
    ...(deps.projectRef !== undefined ? { projectRef: deps.projectRef } : {}),
    defaultProjectRef: deps.defaultProjectRef,
    allowedProjects: deps.allowedProjects,
  });
  const key = `list_states:${inputHash({ ws: deps.workspace, pr: project.id })}`;
  const states = (await deps.cache.memoize(
    key,
    async () => await deps.plane.listStates(deps.workspace, project.id),
  )) as PlaneState[];
  return {
    workspace: deps.workspace,
    project: { id: project.id, identifier: project.identifier },
    states: states.map((s) => ({
      id: s.id,
      name: s.name,
      group: s.group,
      color: s.color,
      sequence: s.sequence,
      default: s.default,
    })),
  };
}
